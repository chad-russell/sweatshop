import { HARNESS_INPUT_CLIP, HARNESS_OUTPUT_CLIP } from "../../lib/harness-limits";
import type { HarnessWorkflowState } from "@ai-sdk/workflow-harness";
import type { BoundSandbox } from "../../db/sandboxes";
import { addUsage, normalizeUsage, readReportedCost, type UsageCounts } from "../../lib/usage/pricing";
import { harnessEventSink } from "../shared/harness-sink";

/** The resume handle a terminal state carries for the next user turn. */
type HarnessResumeFrom = NonNullable<HarnessWorkflowState["resumeFrom"]>;

type MockHarnessWorkflowState = Omit<HarnessWorkflowState, "resumeFrom" | "continueFrom"> & {
  mockStep?: number;
  resumeFrom?: HarnessWorkflowState["resumeFrom"] | { mock: "resume-after-failure" };
  continueFrom?: HarnessWorkflowState["continueFrom"] | { mock: "continue"; step: number };
};

/**
 * 0022/0038: the double-gated test harness uses marker handles, not SDK
 * lifecycle coordinates (type, harnessId, specificationVersion, data).
 * Keep their serialized shape for mock teardown/resume tests; only this
 * boundary asserts SDK compatibility, with every other state field checked.
 * Never pass these handles to a real adapter.
 */
function mockHarnessState(state: MockHarnessWorkflowState): HarnessWorkflowState {
  return state as unknown as HarnessWorkflowState;
}

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

/**
 * harness-bridge-cleanup: a bridge that cannot bind its port (EADDRINUSE,
 * or the adapter's own "exited before becoming ready" wrapper around it)
 * almost always means a PRIOR call's session is still parked or running
 * in this sandbox — before teardown existed, every stuck call surfaced
 * as this raw stack. Name the actual fix instead, but only when there is
 * in fact a saved resume handle for this conversation × kind to point
 * at — a coincidental EADDRINUSE with no prior session is a different
 * problem and should keep its real message. Pure so it's unit-testable
 * without a sandbox or bridge; returns null to mean "rethrow as-is".
 */
export function explainBridgeStartupFailure(message: string, hasStaleResume: boolean, kind: string): string | null {
  if (!hasStaleResume) return null;
  if (!/EADDRINUSE|bridge exited before becoming ready/i.test(message)) return null;
  return (
    `a previous ${kind} session in this sandbox is still running and holding its port — ` +
    "cancel_run it, or wait a moment and try again"
  );
}

export interface HarnessToolStepInput {
  /** The harness session: an agent stage's visit conversation
   *  (`<runId>_<seq>`) — 0022: chat calls go through
   *  startHarnessCallStep instead. */
  conversationId: string;
  /** 0034 A: the owning run — propose_pr records against it. */
  runId: string;
  kind: "pi" | "claude" | "cursor" | "codex";
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
  kind: "pi" | "claude" | "cursor" | "codex";
  task: string;
}): Promise<import("../../lib/chat/harness-call-start").StartHarnessCallResult> {
  "use step";
  const { startHarnessCall } = await import("../../lib/chat/harness-call-start");
  return startHarnessCall(input);
}

/** One semantic harness step (the 0009 grain) — the worker's loop body. */
/** Running totals a call carries between advance steps. */
export interface HarnessTotals {
  usage: UsageCounts | null;
  steps: number;
  toolCalls: number;
  /** 0062: the harness's own cumulative cost (Claude Code); latest wins. */
  reportedCostUsd?: number | null;
  /** 0062: the model the harness actually resolved to (a bare claude
   *  route leaves it to the CLI's default); latest wins. */
  model?: string | null;
}

export async function harnessAdvanceStep(input: {
  callId: string;
  conversationId: string;
  kind: "pi" | "claude" | "cursor" | "codex";
  route: import("../../lib/providers/route").HarnessRoute;
  state: HarnessWorkflowState;
  /** 0047 review fix: running totals so far (tokens + steps) — the
   *  step re-upserts the usage row so a CANCELLED call keeps every
   *  completed step's metering (cancel never reaches the settle write). */
  totals?: HarnessTotals;
}): Promise<{
  state: HarnessWorkflowState;
  text: string;
  toolCalls: number;
  usage: UsageCounts | null;
  totals: HarnessTotals;
}> {
  "use step";
  // Tests: a scripted harness (no sandbox, no model) — two semantic
  // steps then finished, so the worker loop itself is exercised.
  // Double-gated like the chat mock (workflows/chat/model.ts).
  // Mock steps report no usage (null); tests that need a row pass
  // counts into harnessSettleStep directly.
  if (process.env.SWEATSHOP_HARNESS_MOCK && process.env.NODE_ENV === "test") {
    if (process.env.SWEATSHOP_HARNESS_MOCK === "throw") {
      // A step that dies outright (0038: Cursor's bridge could not start).
      const { FatalError } = await import("workflow");
      throw new FatalError("mock harness step blew up");
    }
    if (process.env.SWEATSHOP_HARNESS_MOCK === "fail-resume") {
      // A turn that FAILS but leaves a live session behind (a detached handle).
      return {
        state: mockHarnessState({
          ...input.state,
          status: "failed",
          error: "harness turn emitted an error",
          resumeFrom: { mock: "resume-after-failure" },
        }),
        text: "",
        toolCalls: 0,
        usage: null,
        totals: { usage: null, steps: 0, toolCalls: 0 },
      };
    }
    if (process.env.SWEATSHOP_HARNESS_MOCK === "loop") {
      // A turn that never finishes on its own (tests exercise the
      // step-cap/cancel teardown paths) — always ready_for_next_step,
      // carrying a fake continueFrom so harnessStopStep has something
      // to reattach to, same as a real suspended turn would.
      const n = ((input.state as { mockStep?: number }).mockStep ?? 0) + 1;
      return {
        state: mockHarnessState({
          ...input.state,
          mockStep: n,
          status: "ready_for_next_step",
          continueFrom: { mock: "continue", step: n },
        }),
        text: `mock-harness-step:${n}`,
        toolCalls: 1,
        usage: null,
        totals: { usage: null, steps: n, toolCalls: n },
      };
    }
    const n = ((input.state as { mockStep?: number }).mockStep ?? 0) + 1;
    const done = n >= 2;
    return {
      state: mockHarnessState({
        ...input.state,
        mockStep: n,
        status: done ? "finished" : "ready_for_next_step",
        // A real suspended turn carries continueFrom — the mock needs
        // one too once a step cap under 2 is in play (tests), so the
        // teardown step has something to reattach to.
        ...(done ? {} : { continueFrom: { mock: "continue", step: n } }),
      }),
      text: `mock-harness-step:${n}`,
      toolCalls: 1,
      usage: null,
      totals: { usage: null, steps: n, toolCalls: n },
    };
  }
  const [
    { runHarnessAgentStep },
    { recordHarnessEvent, clipHarnessText },
    { db },
    { getHarnessResumeState },
    { getWritable },
  ] = await Promise.all([
    import("@ai-sdk/workflow-harness"),
    import("../../lib/harness-events"),
    import("../../db"),
    import("../../db/chat"),
    import("workflow"),
  ]);

  // 0062: cumulative, so the latest report wins (never summed).
  let reportedCost: number | null = null;
  // 0062: the agent's own step/end callbacks see the full usage (cache
  // split) and the harness-reported cost that the UI stream drops. They
  // win over the sink's thin finish-step reading and finalResult. Declared
  // before resolveHarnessRunContext so the callbacks below can close over
  // them — the agent built inside it is the one runHarnessAgentStep drives.
  let callbackUsage: UsageCounts | null = null;
  let finishMetadata: Promise<unknown> | null = null;
  let resolvedModel: string | null = null;
  const { sandboxSession, agent, handle } = await resolveHarnessRunContext(input.conversationId, input.route, {
    onStepEnd: (step) => {
      const id = (step as { model?: { modelId?: unknown } }).model?.modelId;
      if (typeof id === "string" && id) resolvedModel = id;
      const next = normalizeUsage(step.usage);
      if (next) callbackUsage = callbackUsage ? addUsage(callbackUsage, next) : next;
      const cost = readReportedCost({ providerMetadata: step.providerMetadata });
      if (cost !== null) reportedCost = cost;
    },
    onResult: (result) => {
      // Resolves only when the turn finishes; a suspended slice never
      // settles it, so it is raced (not awaited bare) below.
      finishMetadata = Promise.resolve(result.providerMetadata).catch(() => undefined);
    },
    onEnd: (event) => {
      const cost = readReportedCost({ providerMetadata: event.providerMetadata });
      if (cost !== null) reportedCost = cost;
    },
  });
  // 0038: the CLI authenticates from a planted auth.json. The host copy
  // is the source of truth, re-planted every step (a refresh the CLI
  // does in the sandbox must never strand it); a missing/expired login
  // fails the call value-shaped instead of as an opaque bridge error.
  // The step is idempotent and the credential never logs.
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

  // Tee UI chunks through the shared sink (0031): events into
  // harness_events (the /h page is the live view), the model-part form
  // into this workflow run's durable stream.
  const out = getWritable<Record<string, unknown>>();
  const writer = out.getWriter();
  let toolCalls = 0;
  // Last finish-step in this semantic step wins (steps are sequential;
  // the worker sums the returned counts).
  let stepUsage: UsageCounts | null = null;
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
      onUsage: (raw) => {
        const next = normalizeUsage(raw);
        if (next) stepUsage = next;
      },
      onFinishMetadata: (chunk) => {
        const cost = readReportedCost(chunk);
        if (cost !== null) reportedCost = cost;
      },
    });

    let state: Awaited<ReturnType<typeof runHarnessAgentStep>>;
    try {
      state = await runHarnessAgentStep({
        agent: agent as never,
        state: input.state,
        sandboxSession: sandboxSession as never,
        writable: sink as never,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stale = getHarnessResumeState(db(), input.conversationId, input.kind);
      const friendly = explainBridgeStartupFailure(message, Boolean(stale), input.kind);
      throw friendly ? new Error(friendly) : err;
    }
    recordHarnessEvent(input.conversationId, input.kind, {
      kind: "step-end",
      text: clipHarnessText(text(), 500),
    });
    // The UI-chunk transform drops finish-step usage. A finished step
    // still carries a thin summary (input/output only) on finalResult.
    if (state.status !== "ready_for_next_step" && finishMetadata) {
      const meta = await Promise.race([
        finishMetadata,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1_500)),
      ]);
      const cost = readReportedCost({ providerMetadata: meta });
      if (cost !== null) reportedCost = cost;
    }
    if (input.route.harness === "claude" && state.status === "finished" && reportedCost === null) {
      console.warn("[usage] claude step reported no cost (providerMetadata['claude-code'].costUsd missing)");
    }
    if (callbackUsage) stepUsage = callbackUsage;
    if (!stepUsage) {
      const summary = (state as { finalResult?: { usage?: unknown } }).finalResult?.usage;
      stepUsage = normalizeUsage(summary);
    }
    if (reportedCost === null) {
      reportedCost = readReportedCost((state as { finalResult?: unknown }).finalResult);
    }
    // 0047 review fix: running totals + an incremental upsert. Cancel
    // never reaches the settle step's usage write, so the row must be
    // current the moment each step lands; the settle write then makes
    // the final pass idempotent (same id, upsert again).
    const totals = {
      usage: input.totals?.usage && stepUsage
        ? addUsage(input.totals.usage, stepUsage)
        : (input.totals?.usage ?? stepUsage),
      steps: (input.totals?.steps ?? 0) + 1,
      toolCalls: (input.totals?.toolCalls ?? 0) + toolCalls,
      reportedCostUsd: reportedCost ?? input.totals?.reportedCostUsd ?? null,
      model: resolvedModel ?? input.totals?.model ?? null,
    };
    try {
      await writeHarnessUsageRow(input.callId, input.conversationId, input.route, totals);
    } catch (err) {
      console.error("[usage] harness checkpoint failed", err);
    }
    return { state, text: text(), toolCalls, usage: stepUsage, totals };
  } finally {
    writer.releaseLock();
  }
}

/**
 * Shared sandbox/agent construction for every step that drives or tears
 * down a harness session (`harnessAdvanceStep`, `harnessStopStep`) — one
 * place that opens the conversation's sandbox, wraps it for the harness
 * SDK, and builds the route's `HarnessAgent`.
 */
async function resolveHarnessRunContext(
  conversationId: string,
  route: import("../../lib/providers/route").HarnessRoute,
  /** 0062: lifecycle taps forwarded straight to `buildHarnessAgent` —
   *  `harnessAdvanceStep` passes them (it drives the agent and wants its
   *  usage/cost callbacks); `harnessStopStep` passes none (it only
   *  reattaches to park or discard the session, never drives a turn). */
  callbacks?: Pick<import("./harness-agent").BuildArgs, "onStepEnd" | "onResult" | "onEnd">,
) {
  const [
    { toNetworkSandboxSession },
    { buildHarnessAgent },
    { db },
    { getConversation },
    { getModelInfo },
    { openConversationSandbox },
  ] = await Promise.all([
    import("../../lib/sandboxes/ai-sdk-adapter"),
    import("./harness-agent"),
    import("../../db"),
    import("../../db/chat"),
    import("../../db/providers"),
    import("../../lib/sandboxes/binding"),
  ]);
  // The conversation's binding — bound on the call's first step if this
  // is the conversation's first sandboxed use (0013).
  const { sandboxId, workDir, handle } = await openConversationSandbox(conversationId);
  const sandboxSession = toNetworkSandboxSession({ id: sandboxId, handle, workDir });
  const projectId = getConversation(db(), conversationId)?.projectId;
  if (!projectId) throw new Error(`conversation ${conversationId} lost its project mid-call`);
  const agent = buildHarnessAgent({
    route,
    sessionId: conversationId,
    tools: {},
    ...(route.harness === "pi" ? { modelInfo: getModelInfo(db(), route.provider, route.model) } : {}),
    ...callbacks,
  });
  return { sandboxSession, agent, handle };
}

/**
 * harness-bridge-cleanup: a cheap "is this call still running?" read,
 * checked between semantic steps (same boundary the step cap uses) so
 * the workflow notices an external `cancel_run` settle and tears down
 * its own live session instead of looping toward the cap with a bridge
 * nobody is driving anymore.
 */
export async function harnessCallIsLiveStep(callId: string): Promise<boolean> {
  "use step";
  const [{ db }, { getHarnessCall }] = await Promise.all([import("../../db"), import("../../db/harness-calls")]);
  return getHarnessCall(db(), callId)?.status === "running";
}

/**
 * harness-bridge-cleanup: tear down the live session a call leaves
 * behind when the workflow stops driving it without the turn itself
 * having finished or failed — the step cap, or an externally cancelled
 * call noticed between steps. Reattaches via the state's `continueFrom`
 * (the live, suspended turn) or, failing that, `resumeFrom` (a session
 * parked by an earlier turn), then either parks it again (`stop()` —
 * the step-cap path, which wants the NEXT call to resume cleanly) or
 * discards it outright (`destroy()` — cancel, which already means "stop,
 * don't continue"). Best-effort: a teardown failure is logged and
 * swallowed, never thrown — the caller's settle must never be masked or
 * skipped, and the worst case of a failed teardown is the exact bug this
 * step exists to fix, not a new one.
 */
export async function harnessStopStep(input: {
  callId: string;
  conversationId: string;
  kind: "pi" | "claude" | "cursor" | "codex";
  route: import("../../lib/providers/route").HarnessRoute;
  state: HarnessWorkflowState;
  /** false (default) = stop() — park for the next call to resume.
   *  true = destroy() — discard resumability (cancel). */
  destroy?: boolean;
}): Promise<{ resumeFrom?: unknown }> {
  "use step";
  const reattachFrom = input.state.continueFrom ?? input.state.resumeFrom;
  if (!reattachFrom) return {}; // nothing live was ever started — nothing to tear down

  try {
    if (process.env.SWEATSHOP_HARNESS_MOCK && process.env.NODE_ENV === "test") {
      if (process.env.SWEATSHOP_HARNESS_MOCK === "stop-throws") {
        throw new Error("mock teardown failed");
      }
      if (input.destroy) {
        // Test observability only: destroy() itself returns nothing to
        // persist (by design — cancel discards resumability), so tests
        // asserting teardown actually ran need SOME durable trace of it.
        const { recordHarnessEvent } = await import("../../lib/harness-events");
        recordHarnessEvent(input.conversationId, input.kind, { kind: "step-end", text: "mock-teardown:destroy" });
        return {};
      }
      return { resumeFrom: { mock: "stopped", from: reattachFrom } };
    }
    const { sandboxSession, agent } = await resolveHarnessRunContext(input.conversationId, input.route);
    const session = await agent.createSession({
      sessionId: input.conversationId,
      ...(input.state.continueFrom
        ? { continueFrom: input.state.continueFrom }
        : { resumeFrom: input.state.resumeFrom }),
      sandboxSession: sandboxSession as never,
    });
    if (input.destroy) {
      await session.destroy();
      return {};
    }
    const resumeFrom = await session.stop();
    return { resumeFrom };
  } catch (err) {
    console.error(`[harness] teardown failed for ${input.callId} (${input.kind})`, err);
    return {};
  }
}

/**
 * 0047 review fix: the ONE usage-row writer for harness calls — an
 * idempotent upsert keyed u_hc_<callId>, shared by the advance-step
 * checkpoint (cancelled calls keep completed metering) and the settle
 * write (the final pass). Never throws at the caller: a metering
 * failure must not fail the step or the settle.
 */
export async function writeHarnessUsageRow(
  callId: string,
  conversationId: string,
  route: import("../../lib/providers/route").HarnessRoute | undefined,
  totals: HarnessTotals,
): Promise<void> {
  const [{ db }, { getPrice, upsertUsageEvent }, { computeCost, roundUsd }, { getHarnessCall }] = await Promise.all([
    import("../../db"),
    import("../../db/usage"),
    import("../../lib/usage/pricing"),
    import("../../db/harness-calls"),
  ]);
  const counts = totals.usage ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let costUsd: number | null = null;
  let costBasis: "computed" | "reported" | null = null;
  if (route?.harness === "pi") {
    const price = getPrice(db(), route.provider, route.model);
    if (price) {
      costUsd = computeCost(price, counts);
      costBasis = "computed";
    }
  } else if (totals.reportedCostUsd != null) {
    // 0062: claude (and any harness that reports one) — the harness's
    // own figure, rounded at the storage boundary like computed costs.
    costUsd = roundUsd(totals.reportedCostUsd);
    costBasis = "reported";
  }
  const call = getHarnessCall(db(), callId);
  const now = Date.now();
  upsertUsageEvent(db(), {
    id: `u_hc_${callId}`,
    conversationId,
    source: "harness",
    harnessCallId: callId,
    // 0062: a bare subscription route (claude/cursor/codex without a
    // pinned model) gets the model the harness resolved, so the panel
    // can say which one ran. Pi's route already carries its model.
    route: JSON.stringify(
      route && !("model" in route && route.model) && totals.model ? { ...route, model: totals.model } : (route ?? {}),
    ),
    inputTokens: counts.inputTokens,
    cachedTokens: counts.cachedTokens,
    cacheWriteTokens: counts.cacheWriteTokens ?? 0,
    outputTokens: counts.outputTokens,
    reasoningTokens: counts.reasoningTokens ?? 0,
    steps: totals.steps,
    toolCalls: totals.toolCalls,
    costUsd,
    costBasis,
    startedAt: call?.createdAt ?? now,
    endedAt: now,
    createdAt: now,
  });
}

/**
 * Terminal: persist the resume handle (natural completion only), settle
 * the call row, release the slot, and wake the conversation with the
 * final text. Exactly-one-settle: a cancelled call cannot be re-settled.
 */
export async function harnessSettleStep(input: {
  callId: string;
  conversationId: string;
  kind: "pi" | "claude" | "cursor" | "codex";
  status: "completed" | "failed";
  /** The whole step-by-step log, joined — kept for harness_events (the
   *  per-step "step-end" events already carry each step's own text; this
   *  one more lands on the terminal "end" event). */
  text: string;
  /** 0040 phase 3: the harness's FINAL message (harness-call.ts's
   *  resultText) — what the result, the result file, and the wake
   *  actually deliver. */
  finalText: string;
  toolCalls: number;
  /** Semantic steps the worker actually ran. */
  steps?: number;
  /** Resolved route (pi has provider+model; claude/cursor/codex do not). */
  route?: import("../../lib/providers/route").HarnessRoute;
  /** Summed model usage; null when no finish-step reported any. */
  usage?: UsageCounts | null;
  /** 0062: the harness's own cumulative cost, when it reports one. */
  reportedCostUsd?: number | null;
  /** 0062: the model the harness resolved to, when it said. */
  model?: string | null;
  error?: string;
  resumeFrom?: unknown;
}): Promise<void> {
  "use step";
  const [
    { db },
    { saveHarnessResumeState },
    { recordHarnessEvent, recordHarnessRunEnd, clipHarnessText },
    { settleHarnessCall, setCallResultFile },
    { wakeConversation, clipText, WAKE_DETAIL_CAP },
    { saveResultFile, RESULT_FILE_CAP },
  ] = await Promise.all([
    import("../../db"),
    import("../../db/chat"),
    import("../../lib/harness-events"),
    import("../../db/harness-calls"),
    import("../../lib/chat/wake"),
    import("../../lib/chat/result-file"),
  ]);

  // A completed turn's handle is the cross-call continuity; a FAILED turn's
  // is just as important when it left a live bridge behind (0038) — without
  // it the next call cannot reattach and a second bridge collides on the
  // port. Cancelled calls never reach here, and a handle only exists when
  // the harness produced one.
  if (input.resumeFrom) {
    saveHarnessResumeState(db(), input.conversationId, input.kind, input.resumeFrom as HarnessResumeFrom);
  }
  // 0040 phase 3: stored (and delivered) whole, up to the same 60 k cap
  // as the result file (the web_fetch context limit) — no longer 2 000.
  const result = clipHarnessText(input.finalText, RESULT_FILE_CAP);
  const settled = settleHarnessCall(db(), input.callId, {
    status: input.status,
    ...(input.status === "completed" ? { result } : {}),
    error: input.error ?? null,
  });
  // The full step-by-step log finds a home here (each step's own text
  // already landed on its own "step-end" event as the call progressed).
  recordHarnessEvent(input.conversationId, input.kind, { kind: "end", text: clipHarnessText(input.text, 500) });
  if (settled) {
    // A racing cancel already released the slot with its own end record.
    recordHarnessRunEnd(
      input.conversationId,
      input.kind,
      input.toolCalls,
      input.status,
      input.error,
    );
    // 0040 phase 3: the full result goes to a file in THIS chat's own
    // sandbox (a harness call has no separate "parent" — it already runs
    // in the conversation it wakes) — only when there is one to write
    // and the call actually completed (a failure's useful information is
    // the error, already delivered inline). Only attempted once this
    // settle has WON the race (inside `if (settled)`) — a racing cancel
    // must never get a late sandbox write attributed to it. The path (or
    // null) is persisted right after — review fix: the sweep path used
    // to derive a path from the binding alone and could point at a file
    // that was never written; now it reads this column back verbatim.
    const resultOutcome =
      input.status === "completed" && input.finalText
        ? await saveResultFile(input.conversationId, input.callId, input.finalText)
        : null;
    if (resultOutcome) setCallResultFile(db(), input.callId, resultOutcome.path);
    // 0047: one usage_events row per call. Recorded before the wake so a
    // wake failure (no workflow runtime, in unit tests) still keeps the
    // row — and a usage failure never fails the settle.
    try {
      await writeHarnessUsageRow(input.callId, input.conversationId, input.route, {
        usage: input.usage ?? null,
        steps: input.steps ?? 0,
        toolCalls: input.toolCalls,
        reportedCostUsd: input.reportedCostUsd ?? null,
        model: input.model ?? null,
      });
    } catch (err) {
      console.error("[usage] harness capture failed", err);
    }
    await wakeConversation(input.conversationId, {
      kind: "harness",
      id: input.callId,
      name: input.kind,
      status: input.status,
      detail:
        input.status === "failed"
          ? (input.error ?? null)
          : clipText(input.finalText, WAKE_DETAIL_CAP, { id: input.callId, file: resultOutcome?.path ?? null }),
      url: `/h/${input.kind}/${input.conversationId}`,
      ...(input.status === "completed" && input.finalText
        ? {
            // review fix: the length of what was actually SAVED/STORED
            // (the same clipHarnessText(…, RESULT_FILE_CAP) value just
            // written to harness_calls.result above — `result` is always
            // a string here, clipHarnessText only returns undefined for
            // falsy input, and input.finalText is truthy in this branch),
            // not the raw pre-cap finalText — a >60k result no longer
            // claims a size the file on disk does not have.
            result:
              resultOutcome?.path === null
                ? { chars: result!.length, file: null, reason: resultOutcome.reason }
                : { chars: result!.length, file: resultOutcome?.path ?? null },
          }
        : {}),
    });
  }
}
