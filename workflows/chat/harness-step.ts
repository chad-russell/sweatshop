import { HARNESS_INPUT_CLIP, HARNESS_OUTPUT_CLIP } from "../../lib/harness-limits";
import type { HarnessWorkflowState } from "@ai-sdk/workflow-harness";
import type { BoundSandbox } from "../../db/sandboxes";
import { harnessEventSink } from "../shared/harness-sink";

/** The resume handle a terminal state carries for the next user turn. */
type HarnessResumeFrom = NonNullable<HarnessWorkflowState["resumeFrom"]>;

/**
 * 0010 Phase 3b: the chat harness steps. `harnessToolStep` is the
 * agent-stage path (0010 Phase 5): one synchronous `"use step"` per
 * tool call that advances the harness turn to completion inside the
 * stage's own step — machine runs are already async from every chat, so
 * stages keep the simple blocking shape.
 *
 * 0022 cut 2: CHAT pi/claude calls are background work instead —
 * `startHarnessCallStep` claims the slot, records the call, and returns
 * a handle immediately; the `harnessCall` workflow (./harness-call.ts)
 * advances the turn one semantic step per `"use step"`
 * (`harnessAdvanceStep`) and settles + wakes (`harnessSettleStep`).
 * Cross-call continuity is unchanged: the terminal `resumeFrom` handle
 * persists in chat_harness_state and seeds the next call.
 *
 * Events are recorded per conversation × kind into harness_events —
 * /h/<kind>/<conversationId> is the view (0005/0006 unchanged), and
 * the live-activity page for background calls.
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
  /** The harness session: an agent stage's visit conversation
   *  (`<runId>_<seq>`) — 0022: chat calls go through
   *  startHarnessCallStep instead. */
  conversationId: string;
  kind: "pi" | "claude";
  task: string;
  /** 0013: run in this binding (the run's) with this project. */
  inherited: { binding: BoundSandbox; projectId: string };
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
  const projectId = inherited.projectId;
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
    // 0013: the stage's inherited binding — the run's sandbox, in the
    // bound working directory.
    const { openInheritedSandbox } = await import("../../lib/sandboxes/binding");
    const { sandboxId, workDir, handle } = await openInheritedSandbox(inherited.binding);
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

// --- 0022 cut 2: background chat harness calls ------------------------------

/**
 * The chat pi/claude tools' step (0022) — the lib/chat/harness-call-start
 * core (validation, slot claim, the harness_calls row, the workflow
 * start) wrapped as a step; returns the handle. The turn never advances
 * the harness itself; the result arrives as a wake message.
 */
export async function startHarnessCallStep(input: {
  conversationId: string;
  kind: "pi" | "claude";
  task: string;
}): Promise<import("../../lib/chat/harness-call-start").StartHarnessCallResult> {
  "use step";
  const { startHarnessCall } = await import("../../lib/chat/harness-call-start");
  return startHarnessCall(input);
}

/** One semantic harness step (the 0009 grain) — the worker's loop body. */
export async function harnessAdvanceStep(input: {
  callId: string;
  conversationId: string;
  kind: "pi" | "claude";
  route: import("../../lib/providers/route").HarnessRoute;
  state: HarnessWorkflowState;
}): Promise<{ state: HarnessWorkflowState; text: string; toolCalls: number }> {
  "use step";
  // Tests: a scripted harness (no sandbox, no model) — two semantic
  // steps then finished, so the worker loop itself is exercised.
  // Double-gated like the chat mock (workflows/chat/model.ts).
  if (process.env.SWEATSHOP_HARNESS_MOCK && process.env.NODE_ENV === "test") {
    const n = ((input.state as { mockStep?: number }).mockStep ?? 0) + 1;
    const done = n >= 2;
    return {
      state: { ...input.state, mockStep: n, status: done ? "finished" : "ready_for_next_step" } as HarnessWorkflowState,
      text: `mock-harness-step:${n}`,
      toolCalls: 1,
    };
  }
  const [
    { runHarnessAgentStep },
    { toNetworkSandboxSession },
    { buildHarnessAgent, createPrTool },
    { recordHarnessEvent, clipHarnessText },
    { db },
    { getConversation },
    { getWritable },
    { getModelInfo },
    { openConversationSandbox },
  ] = await Promise.all([
    import("@ai-sdk/workflow-harness"),
    import("../../lib/sandboxes/ai-sdk-adapter"),
    import("../machines/harness-agent"),
    import("../../lib/harness-events"),
    import("../../db"),
    import("../../db/chat"),
    import("workflow"),
    import("../../db/providers"),
    import("../../lib/sandboxes/binding"),
  ]);

  // The conversation's binding — bound on the call's first step if this
  // is the conversation's first sandboxed use (0013).
  const { sandboxId, workDir, handle } = await openConversationSandbox(input.conversationId);
  const sandboxSession = toNetworkSandboxSession({ id: sandboxId, handle, workDir });

  // Tee UI chunks through the shared sink (0031): events into
  // harness_events (the /h page is the live view), the model-part form
  // into this workflow run's durable stream.
  const out = getWritable<Record<string, unknown>>();
  const writer = out.getWriter();
  let toolCalls = 0;
  try {
    const { sink, text } = harnessEventSink({
      recordEvent: (event) => recordHarnessEvent(input.conversationId, input.kind, event),
      clip: clipHarnessText,
      inputClip: HARNESS_INPUT_CLIP,
      outputClip: HARNESS_OUTPUT_CLIP,
      writer,
      forward: uiChunkToModelPart,
      envelope: { chatConversation: input.conversationId, chatHarness: input.kind, callId: input.callId },
      onToolStart: (name) => {
        if (name !== "fileChange" && name !== "compaction") toolCalls += 1;
      },
    });

    const projectId = getConversation(db(), input.conversationId)?.projectId;
    if (!projectId) throw new Error(`conversation ${input.conversationId} lost its project mid-call`);
    const agent = buildHarnessAgent({
      route: input.route,
      sessionId: input.conversationId,
      tools: { create_pr: createPrTool(projectId) },
      ...(input.route.harness === "pi"
        ? { modelInfo: getModelInfo(db(), input.route.provider, input.route.model) }
        : {}),
    });
    const state = await runHarnessAgentStep({
      agent: agent as never,
      state: input.state,
      sandboxSession: sandboxSession as never,
      writable: sink as never,
    });
    recordHarnessEvent(input.conversationId, input.kind, {
      kind: "step-end",
      text: clipHarnessText(text(), 500),
    });
    return { state, text: text(), toolCalls };
  } finally {
    writer.releaseLock();
  }
}

/**
 * Terminal: persist the resume handle (natural completion only), settle
 * the call row, release the slot, and wake the conversation with the
 * final text. Exactly-one-settle: a cancelled call cannot be re-settled.
 */
export async function harnessSettleStep(input: {
  callId: string;
  conversationId: string;
  kind: "pi" | "claude";
  status: "completed" | "failed";
  text: string;
  toolCalls: number;
  error?: string;
  resumeFrom?: unknown;
}): Promise<void> {
  "use step";
  const [
    { db },
    { saveHarnessResumeState },
    { recordHarnessEvent, recordHarnessRunEnd, clipHarnessText },
    { settleHarnessCall },
    { wakeConversation },
  ] = await Promise.all([
    import("../../db"),
    import("../../db/chat"),
    import("../../lib/harness-events"),
    import("../../db/harness-calls"),
    import("../../lib/chat/wake"),
  ]);

  if (input.status === "completed" && input.resumeFrom) {
    saveHarnessResumeState(db(), input.conversationId, input.kind, input.resumeFrom as HarnessResumeFrom);
  }
  const result = clipHarnessText(input.text, 2_000);
  const settled = settleHarnessCall(db(), input.callId, {
    status: input.status,
    ...(input.status === "completed" ? { result } : {}),
    error: input.error ?? null,
  });
  recordHarnessEvent(input.conversationId, input.kind, { kind: "end" });
  if (settled) {
    // A racing cancel already released the slot with its own end record.
    recordHarnessRunEnd(
      input.conversationId,
      input.kind,
      input.toolCalls,
      input.status,
      input.error,
    );
    await wakeConversation(input.conversationId, {
      kind: "harness",
      id: input.callId,
      name: input.kind,
      status: input.status,
      detail: input.status === "failed" ? (input.error ?? null) : clipHarnessText(input.text, 500),
      url: `/h/${input.kind}/${input.conversationId}`,
    });
  }
}
