import { HARNESS_INPUT_CLIP, HARNESS_OUTPUT_CLIP } from "../../lib/harness-limits";
import type { HarnessWorkflowState } from "@ai-sdk/workflow-harness";
import type { BoundSandbox } from "../../db/sandboxes";
import { harnessEventSink } from "../shared/harness-sink";

/** The resume handle a terminal state carries for the next user turn. */
type HarnessResumeFrom = NonNullable<HarnessWorkflowState["resumeFrom"]>;

/**
 * 0010 Phase 3b: the chat harness tool's ONE workflow step — the whole
 * pi/claude tool call (port of agent/lib/harness-tool.ts + agent/tools/
 * {pi,claude}.ts onto the lease seam). Node-only, so everything happens
 * inside the step: acquire the conversation's sandbox, claim the one-
 * run-per-sandbox slot (0006), then advance the harness turn semantic
 * step by semantic step (runHarnessAgentStep + isStepCount(1), the 0009
 * grain) until the turn ends.
 *
 * Cross-call continuity is durable, not cached: the terminal state's
 * `resumeFrom` handle is persisted to chat_harness_state, and the next
 * tool call seeds its turn with it — the same harness session resumes
 * with prior context (this replaces eve's in-memory session cache and
 * its sandbox-identity eviction; a replaced sandbox simply resumes from
 * the handle).
 *
 * Events are recorded per conversation × kind into harness_events —
 * /h/<kind>/<conversationId> is the view (0005/0006 unchanged).
 */

const MAX_STEPS = 200;

/**
 * UI chunk → ModelCallStreamPart. runHarnessAgentStep emits UI chunks,
 * but the durable run stream carries ModelCallStreamPart values
 * (ChatSessionModeling.md) and the routes convert with
 * createModelCallToUIChunkTransform — which re-keys by the model-part
 * shape, so a raw UI `tool-input-start` would lose its toolCallId and
 * fail the client's stream schema. Translate at the sink; this is the
 * exact inverse of the transform's toUIMessageChunk cases that the
 * harness emits. Chunk types with no model-part form (message-metadata,
 * source-*, file, custom data-*) drop out — the transform would drop
 * those anyway.
 */
function uiChunkToModelPart(chunk: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta =
    chunk.providerMetadata != null ? { providerMetadata: chunk.providerMetadata } : {};
  switch (chunk.type) {
    // Identical shapes both ways.
    case "text-start":
    case "text-end":
    case "reasoning-start":
    case "reasoning-end":
    case "start-step":
    case "finish-step":
    case "reset-step":
    case "tool-output-denied":
      return chunk;
    case "text-delta":
    case "reasoning-delta":
      return { type: chunk.type, id: chunk.id, text: chunk.delta, ...meta };
    case "tool-input-start":
      return {
        type: "tool-input-start",
        id: chunk.toolCallId,
        toolName: chunk.toolName,
        ...(chunk.providerExecuted != null ? { providerExecuted: chunk.providerExecuted } : {}),
        ...(chunk.dynamic != null ? { dynamic: chunk.dynamic } : {}),
      };
    case "tool-input-delta":
      return {
        type: "tool-input-delta",
        id: chunk.toolCallId,
        delta: chunk.inputTextDelta,
      };
    case "tool-input-available":
      return {
        type: "tool-call",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.input,
        ...(chunk.providerExecuted != null ? { providerExecuted: chunk.providerExecuted } : {}),
        ...meta,
      };
    case "tool-output-available":
      return { type: "tool-result", toolCallId: chunk.toolCallId, output: chunk.output };
    case "tool-output-error":
      return { type: "tool-error", toolCallId: chunk.toolCallId, error: chunk.errorText };
    case "error":
      return { type: "error", error: chunk.errorText };
    case "tool-approval-request":
      return {
        type: "tool-approval-request",
        approvalId: chunk.approvalId,
        toolCall: { toolCallId: chunk.toolCallId },
        ...(chunk.signature != null ? { signature: chunk.signature } : {}),
      };
    default:
      return undefined;
  }
}

export interface HarnessToolStepInput {
  /** The harness session: a chat's conversation id, or an agent stage's
   *  visit conversation (`<runId>_<seq>`). */
  conversationId: string;
  kind: "pi" | "claude";
  task: string;
  /** 0013: run in this binding (an agent stage's — the run's) with
   *  this project, instead of the conversation's own binding. */
  inherited?: { binding: BoundSandbox; projectId: string };
}

export interface HarnessToolStepResult {
  text: string;
  toolCalls: number;
  harnessUrl: string;
  eventLogUrl: string;
}

export async function harnessToolStep(
  input: HarnessToolStepInput,
): Promise<HarnessToolStepResult> {
  "use step";
  const { conversationId, kind, task, inherited } = input;
  const [
    { createHarnessWorkflowState, runHarnessAgentStep },
    { toNetworkSandboxSession },
    { buildHarnessAgent, createPrTool },
    { claimHarnessRun, clipHarnessText, getActiveHarnessRun, recordHarnessEvent, recordHarnessRunEnd },
    { db },
    { getConversation, getHarnessResumeState, saveHarnessResumeState },
    { getWritable },
    { requireRoute },
    { getModelInfo },
  ] = await Promise.all([
    import("@ai-sdk/workflow-harness"),
    import("../../lib/sandboxes/ai-sdk-adapter"),
    import("../machines/harness-agent"),
    import("../../lib/harness-events"),
    import("../../db"),
    import("../../db/chat"),
    import("workflow"),
    import("../../lib/providers/resolve"),
    import("../../db/providers"),
  ]);

  const conversation = getConversation(db(), conversationId);
  const projectId = inherited?.projectId ?? conversation?.projectId;
  if (!projectId) {
    throw new Error(
      `${kind} requires a project conversation — start one from a project page`,
    );
  }
  if (kind === "claude" && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      "claude is not configured — set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) in the app environment",
    );
  }

  // 0021: pi inherits the conversation's route (provider + model, the
  // harness swapped in), else the project / global pi default; claude
  // takes its own global setting (subscription only). Checked before the
  // slot is claimed so a forbidden route never holds the sandbox.
  const { route } = requireRoute(db(), kind, { conversation: conversation?.route ?? null }, projectId);

  // v1 concurrency contract: one harness at a time per sandbox (0006).
  if (!claimHarnessRun(conversationId, kind)) {
    const active = getActiveHarnessRun(conversationId);
    throw new Error(
      `a ${active?.kind ?? "harness"} run is already active in this conversation — ` +
        `wait for it to finish before starting ${kind}`,
    );
  }

  let toolCalls = 0;
  let failure: string | undefined;
  try {
    // 0013: the conversation's binding — its own sandbox (bound on first
    // use) or the one it attached to, in the bound working directory.
    // An agent stage passes the run's binding instead (0013 inherit).
    const { openConversationSandbox, openInheritedSandbox } = await import("../../lib/sandboxes/binding");
    const { sandboxId, workDir, handle } = inherited
      ? await openInheritedSandbox(inherited.binding)
      : await openConversationSandbox(conversationId);
    const sandboxSession = toNetworkSandboxSession({ id: sandboxId, handle, workDir });

    const resumeFrom =
      (getHarnessResumeState(db(), conversationId, kind) as HarnessResumeFrom | null) ?? undefined;
    let state: HarnessWorkflowState = createHarnessWorkflowState({
      sessionId: conversationId,
      prompt: task,
      resumeFrom,
    });

    // Tee the UI chunks through the shared harness sink (0031): events
    // into harness_events, the model-part form to the turn's output
    // stream (the chat shows harness activity live).
    const out = getWritable<Record<string, unknown>>();
    const writer = out.getWriter();
    const { sink, text } = harnessEventSink({
      recordEvent: (event) => recordHarnessEvent(conversationId, kind, event),
      clip: clipHarnessText,
      inputClip: HARNESS_INPUT_CLIP,
      outputClip: HARNESS_OUTPUT_CLIP,
      writer,
      forward: uiChunkToModelPart,
      envelope: { chatConversation: conversationId, chatHarness: kind },
      onToolStart: (name) => {
        if (name !== "fileChange" && name !== "compaction") toolCalls += 1;
      },
    });

    const hostTools = { create_pr: createPrTool(projectId) };

    recordHarnessEvent(conversationId, kind, { kind: "start" });
    try {
      let steps = 0;
      do {
        const agent = buildHarnessAgent({
          route,
          sessionId: conversationId,
          tools: hostTools,
          ...(route.harness === "pi" ? { modelInfo: getModelInfo(db(), route.provider, route.model) } : {}),
        });
        state = await runHarnessAgentStep({
          agent: agent as never,
          state,
          sandboxSession: sandboxSession as never,
          writable: sink as never,
        });
        steps += 1;
        recordHarnessEvent(conversationId, kind, {
          kind: "step-end",
          text: clipHarnessText(text(), 500),
        });
      } while (state.status === "ready_for_next_step" && steps < MAX_STEPS);
    } finally {
      writer.releaseLock();
    }

    if (state.status === "failed") {
      throw new Error(state.error ?? `${kind} turn failed`);
    }
    // Park the session and remember how to resume it (destroyOnFinish
    // stays false — the next tool call continues the same session).
    if (state.resumeFrom) {
      saveHarnessResumeState(db(), conversationId, kind, state.resumeFrom);
    }

    return {
      text: text(),
      toolCalls,
      harnessUrl: `/h/${kind}/${conversationId}`,
      eventLogUrl: `/api/harness/${conversationId}?harness=${kind}`,
    };
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    // 0006: failures are failures — keep the transcript, record why.
    recordHarnessRunEnd(conversationId, kind, toolCalls, failure ? "failed" : "completed", failure);
  }
}
