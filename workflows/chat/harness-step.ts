import type { HarnessWorkflowState } from "@ai-sdk/workflow-harness";

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
  conversationId: string;
  kind: "pi" | "claude";
  task: string;
  /** 0011: the AI SDK tool call, for sandbox attribution. */
  toolCallId?: string;
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
  const { conversationId, kind, task, toolCallId } = input;
  const [
    { createHarnessWorkflowState, runHarnessAgentStep },
    { toNetworkSandboxSession },
    { buildHarnessAgent },
    { claimHarnessRun, clipHarnessText, getActiveHarnessRun, recordHarnessEvent, recordHarnessRunEnd },
    { openProjectPR },
    { db },
    { getConversation, getHarnessResumeState, saveHarnessResumeState },
    { getWritable },
    { tool },
    { z },
  ] = await Promise.all([
    import("@ai-sdk/workflow-harness"),
    import("../../lib/sandboxes/ai-sdk-adapter"),
    import("../machines/harness-agent"),
    import("../../lib/harness-events"),
    import("../../lib/git-hosts/open-pr"),
    import("../../db"),
    import("../../db/chat"),
    import("workflow"),
    import("ai"),
    import("zod"),
  ]);

  const conversation = getConversation(db(), conversationId);
  if (!conversation?.projectId) {
    throw new Error(
      `${kind} requires a project conversation — start one from a project page`,
    );
  }
  if (kind === "claude" && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      "claude is not configured — set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) in the app environment",
    );
  }

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
    // The conversation's sandbox — its explicit pref decides dedicated
    // (lazy, /work/<conversationId> is the cwd the harness resolves as
    // its home) or attached.
    const { acquireConversationSandbox } = await import("../../lib/agent/tools/sandbox-pref");
    const { sandboxId, handle } = await acquireConversationSandbox(
      conversationId,
      conversation.projectId,
      undefined,
      toolCallId ? { toolCallId, tool: kind } : undefined,
    );
    // Dedicated and attached both work under /work/<conversationId>.
    const { sandboxWorkRoot } = await import("../../lib/sandboxes/provision");
    const sandboxSession = toNetworkSandboxSession({
      id: sandboxId,
      handle,
      workDir: sandboxWorkRoot(conversationId),
    });

    const resumeFrom =
      (getHarnessResumeState(db(), conversationId, kind) as HarnessResumeFrom | null) ?? undefined;
    let state: HarnessWorkflowState = createHarnessWorkflowState({
      sessionId: conversationId,
      prompt: task,
      resumeFrom,
    });

    // Tee the UI chunks: forward to the turn's output stream (the chat
    // shows harness activity live) and mirror the useful ones into
    // harness_events (0005 visibility).
    const out = getWritable<Record<string, unknown>>();
    const writer = out.getWriter();
    let text = "";
    const toolNames = new Map<string, string>();
    const sink = new WritableStream<Record<string, unknown>>({
      async write(chunk) {
        switch (chunk.type) {
          case "text-delta":
            text += String(chunk.delta ?? "");
            break;
          case "tool-input-available": {
            const name = String(chunk.toolName ?? "");
            toolNames.set(String(chunk.toolCallId), name);
            toolCalls += 1;
            recordHarnessEvent(conversationId, kind, {
              kind: "tool-start",
              toolName: name,
              input: clipHarnessText(chunk.input, 1000),
            });
            break;
          }
          case "tool-output-available": {
            const name = toolNames.get(String(chunk.toolCallId)) ?? "tool";
            recordHarnessEvent(conversationId, kind, {
              kind: "tool-end",
              toolName: name,
              output: clipHarnessText(chunk.output, 2000),
            });
            break;
          }
        }
        // Events are recorded from the UI chunk (its shape is what the
        // harness emits); the durable stream gets the model-part form.
        const part = uiChunkToModelPart(chunk);
        if (part !== undefined) {
          await writer.write({ ...part, chatConversation: conversationId, chatHarness: kind });
        }
      },
    });

    const projectId = conversation.projectId;
    const hostTools = {
      create_pr: tool({
        description:
          "Open a pull request for a pushed branch of one of this project's repos " +
          "(repo = directory name under the work root). Push the branch first.",
        inputSchema: z.object({
          repo: z.string(),
          head: z.string(),
          base: z.string().optional(),
          title: z.string().min(1),
          body: z.string().optional(),
        }),
        execute: async (args: {
          repo: string;
          head: string;
          base?: string;
          title: string;
          body?: string;
        }) => openProjectPR({ projectId, ...args }),
      }),
    };

    recordHarnessEvent(conversationId, kind, { kind: "start" });
    try {
      let steps = 0;
      do {
        const agent = buildHarnessAgent({
          harness: kind,
          sessionId: conversationId,
          tools: hostTools,
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
          text: clipHarnessText(text, 500),
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
      text,
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
