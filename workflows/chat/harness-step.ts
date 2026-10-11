import { HARNESS_INPUT_CLIP, HARNESS_OUTPUT_CLIP } from "../../lib/harness-limits";
import type { HarnessWorkflowState } from "@ai-sdk/workflow-harness";
import type { BoundSandbox } from "../../db/sandboxes";
import { harnessEventSink } from "../shared/harness-sink";

/** The resume handle a terminal state carries for the next user turn. */
type HarnessResumeFrom = NonNullable<HarnessWorkflowState["resumeFrom"]>;

/**
 * 0010 Phase 3b: the chat harness steps. (The synchronous
 * agent-stage path died with machines, 0037 phase 5.)
 *
 * 0022 cut 2: CHAT pi/claude calls are background work —
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
  /** 0034 A: the owning run — propose_pr records against it. */
  runId: string;
  kind: "pi" | "claude" | "cursor";
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


// --- 0022 cut 2: background chat harness calls ------------------------------

/**
 * The chat pi/claude tools' step (0022) — the lib/chat/harness-call-start
 * core (validation, slot claim, the harness_calls row, the workflow
 * start) wrapped as a step; returns the handle. The turn never advances
 * the harness itself; the result arrives as a wake message.
 */
export async function startHarnessCallStep(input: {
  conversationId: string;
  kind: "pi" | "claude" | "cursor";
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
  kind: "pi" | "claude" | "cursor";
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
    { buildHarnessAgent },
    { recordHarnessEvent, clipHarnessText },
    { db },
    { getConversation },
    { getWritable },
    { getModelInfo },
    { openConversationSandbox },
  ] = await Promise.all([
    import("@ai-sdk/workflow-harness"),
    import("../../lib/sandboxes/ai-sdk-adapter"),
    import("./harness-agent"),
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
    // 0038: the CLI authenticates from a planted auth.json. The host
    // copy is the source of truth, re-planted every step (a refresh the
    // CLI does in the sandbox must never strand it); a missing/expired
    // login fails the call value-shaped instead of as an opaque bridge
    // error. The step is idempotent and the credential never logs.
    if (input.route.harness === "cursor") {
      const [{ cursorCredential, plantCursorCredential }, { FatalError }] = await Promise.all([
        import("../../lib/harness-auth/cursor"),
        import("workflow"),
      ]);
      const credential = cursorCredential();
      if (!credential.ok) throw new FatalError(credential.message);
      const planted = await plantCursorCredential(handle, credential.json);
      if (!planted.ok) throw new FatalError(planted.message);
    }
    // 0034 A: a CHAT harness call has no git tool at all — publishing
    // is the chat agent's act (its gated create_pr) after the wake.
    const agent = buildHarnessAgent({
      route: input.route,
      sessionId: input.conversationId,
      tools: {},
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
  kind: "pi" | "claude" | "cursor";
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
