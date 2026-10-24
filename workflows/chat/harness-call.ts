import type { HarnessWorkflowState } from "@ai-sdk/workflow-harness";
import type { HarnessRoute } from "../../lib/providers/route";
import { harnessAdvanceStep, harnessCallIsLiveStep, harnessSettleStep, harnessStopStep } from "./harness-step";

/**
 * 0022 cut 2: the background harness call worker — one workflow run per
 * chat pi/claude call. The body is pure orchestration (the workflow
 * transform forbids Node here): one `harnessAdvanceStep` per semantic
 * agent step (the 0009 grain — crash-resumable at that boundary), then
 * one `harnessSettleStep` that persists the resume handle, settles the
 * harness_calls row, releases this kind's concurrency slot (0038
 * amendment: one slot per kind, up to MAX_CONCURRENT_HARNESSES total —
 * lib/harness-events.ts), and wakes the conversation with the final text.
 *
 * The initial state is built inline (the run-machine trick) so the
 * bundle stays free of runtime harness imports; `resumeFrom` arrives in
 * the input as plain data (the starter read it from chat_harness_state).
 *
 * harness-bridge-cleanup: the loop rechecks the call's own row between
 * every step (`harnessCallIsLiveStep`) — if `cancel_run` settled it from
 * outside, this run's only job left is tearing down the live session
 * (`harnessStopStep`, `destroy()`) so its bridge doesn't outlive it. This
 * is the ONLY cancellation mechanism: `cancel_run` deliberately never
 * calls `workflow.cancel()` on this run (lib/agent/tools/cancel-run.ts)
 * — a cancelled Workflow DevKit run stops being replayed at its next
 * processing boundary, which would race this very check and usually win,
 * skipping teardown entirely. The step cap does the same teardown
 * (`stop()` — parked, not discarded, so the NEXT call resumes it) before
 * settling failed; a plain SDK failure already carries its own
 * `resumeFrom` and needs no extra step.
 */

const MAX_STEPS = 400;

export interface HarnessCallInput {
  callId: string;
  conversationId: string;
  kind: "pi" | "claude" | "cursor" | "codex";
  task: string;
  /** 0021: resolved by the starter (route crossing step boundaries as
   *  plain data — the SerializableChatModel protocol is per-turn, not
   *  applicable to a detached call). */
  route: HarnessRoute;
  /** The previous turn's resume handle, when the session continues. */
  resumeFrom?: unknown;
  /** 0083: a lane — a fresh session rooted at this sandbox-relative dir,
   *  never chat_harness_state's resume continuity. */
  dir?: string;
  /** 0083: the lane bridge port the claim granted (bridge-backed kinds
   *  only). */
  port?: number;
  /** 0083: the harness's own session identity for a lane call (see
   *  lib/chat/harness-call-start.ts); unset = use `conversationId`. */
  harnessSessionId?: string;
  /** Test-only override of MAX_STEPS — never set in production. */
  maxSteps?: number;
}

export async function harnessCall(input: HarnessCallInput): Promise<{ status: string }> {
  "use workflow";
  const { callId, conversationId, kind, task, route, dir, port } = input;
  const maxSteps = input.maxSteps ?? MAX_STEPS;

  let state = {
    sessionId: input.harnessSessionId ?? conversationId,
    prompt: task,
    status: "not_started",
    ...(input.resumeFrom ? { resumeFrom: input.resumeFrom } : {}),
  } as HarnessWorkflowState;
  let text = "";
  // 0040 phase 3: the result is the harness's FINAL message, not every
  // step's text joined together (a smoke run showed the joined log
  // reading "Now let's look at…" — mid-thought, never the actual
  // conclusion). `lastStepHadText` tracks whether the step that produced
  // `finalText` was the very last one; if not, an earlier step's text is
  // all there is, and it is prefixed to say so.
  let finalText = "";
  let lastStepHadText = false;
  let toolCalls = 0;
  let steps = 0;
  // 0047: summed across semantic steps (kept as the loop's running
  // totals so each advance step can checkpoint them into the usage row).
  let usage: import("../../lib/usage/pricing").UsageCounts | null = null;
  // 0062: the harness's own cumulative cost (Claude Code); latest wins.
  let reportedCostUsd: number | null = null;
  // 0062: the model the harness resolved to; latest wins.
  let model: string | null = null;
  // harness-bridge-cleanup: set when this call was settled from OUTSIDE
  // (cancel_run) between two semantic steps — noticed the same way a
  // human would reload the row, no special signal from the step itself.
  // The row is already settled at that point; this run's only job left
  // is tearing down the live session so its bridge doesn't outlive it.
  let cancelledExternally = false;
  // do…while: the fresh state is "not_started", so a plain while never
  // ran the harness at all and every call "completed" in 0 s with no
  // output (caught live 2026-10-07). Same shape as run-machine's loop.
  try {
    do {
      if (!(await harnessCallIsLiveStep(callId))) {
        cancelledExternally = true;
        break;
      }
      const r = await harnessAdvanceStep({
        callId,
        conversationId,
        kind,
        route,
        state,
        dir,
        port,
        totals: { usage, steps, toolCalls, reportedCostUsd, model },
      });
      state = r.state;
      lastStepHadText = Boolean(r.text);
      if (r.text) {
        text += (text ? "\n\n" : "") + r.text;
        finalText = r.text;
      }
      toolCalls += r.toolCalls;
      // 0047: the step already checkpointed these totals into the usage
      // row — trust its fold (identical arithmetic, one source of truth).
      if (r.totals) {
        usage = r.totals.usage;
        steps = r.totals.steps;
        toolCalls = r.totals.toolCalls;
        reportedCostUsd = r.totals.reportedCostUsd ?? reportedCostUsd;
        model = r.totals.model ?? model;
      }
    } while (state.status === "ready_for_next_step" && steps < maxSteps);
  } catch (err) {
    // A step that exhausts its retries (the bridge could not start, the
    // sandbox is gone, a FatalError) throws HERE. Uncaught, the workflow
    // dies and nothing ever settles the call: the harness_calls row stays
    // `running` forever, this kind's slot stays held (every later call of
    // the SAME kind is "busy"), and the chat is never woken (0038: a
    // Cursor call sat "running" for good). Settle it failed instead — the
    // settle step releases the slot and wakes the chat with the reason.
    await harnessSettleStep({
      callId,
      conversationId,
      kind,
      dir,
      status: "failed",
      text,
      finalText: resultText(finalText, lastStepHadText),
      toolCalls,
      steps,
      route,
      usage,
      reportedCostUsd,
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "failed" };
  }

  if (cancelledExternally) {
    // cancel_run already settled the row (status "cancelled") from
    // outside this run — settling again here would be a no-op at best
    // (settleHarnessCall only updates a still-"running" row) and wrong
    // at worst. The only thing left to do is stop the live session so
    // its bridge doesn't outlive the call (destroy: cancel means "stop,
    // don't continue" — unlike the step cap, there is no next call
    // waiting to resume this one).
    await harnessStopStep({ callId, conversationId, kind, route, state, dir, port, destroy: true });
    return { status: "cancelled" };
  }

  if (state.status === "failed") {
    await harnessSettleStep({
      callId,
      conversationId,
      kind,
      dir,
      status: "failed",
      text,
      finalText: resultText(finalText, lastStepHadText),
      toolCalls,
      steps,
      route,
      usage,
      reportedCostUsd,
      model,
      error: state.error ?? `${kind} turn failed`,
      // A failed turn can leave a LIVE session behind (the bridge process
      // keeps its port). Keep the handle so the next call reattaches to it
      // instead of spawning a second bridge that dies on EADDRINUSE.
      resumeFrom: state.resumeFrom,
    });
    return { status: "failed" };
  }
  if (state.status === "awaiting_tool_approval") {
    // v1 host tools declare no approvals; reaching here is a bug.
    await harnessSettleStep({
      callId,
      conversationId,
      kind,
      dir,
      status: "failed",
      text,
      finalText: resultText(finalText, lastStepHadText),
      toolCalls,
      steps,
      route,
      usage,
      reportedCostUsd,
      model,
      error: "harness requested a tool approval (unsupported in v1)",
    });
    return { status: "failed" };
  }
  if (state.status === "ready_for_next_step") {
    // harness-bridge-cleanup: the turn is still live — the step cap
    // stopped US from driving it further, but the bridge is still up
    // and holding its port until something parks it. Reattach via the
    // suspended turn's own continueFrom and stop() it (park, don't
    // discard — unlike cancel, the NEXT call in this conversation
    // should resume right where this one left off).
    const { resumeFrom } = await harnessStopStep({ callId, conversationId, kind, route, state, dir, port });
    await harnessSettleStep({
      callId,
      conversationId,
      kind,
      dir,
      status: "failed",
      text,
      finalText: resultText(finalText, lastStepHadText),
      toolCalls,
      steps,
      route,
      usage,
      reportedCostUsd,
      model,
      error: `exceeded ${maxSteps} agent steps`,
      resumeFrom,
    });
    return { status: "failed" };
  }

  // finished
  await harnessSettleStep({
    callId,
    conversationId,
    kind,
    dir,
    status: "completed",
    text,
    finalText: resultText(finalText, lastStepHadText),
    toolCalls,
    steps,
    route,
    usage,
    reportedCostUsd,
    model,
    resumeFrom: state.resumeFrom,
  });
  return { status: "completed" };
}

/** The result text: the last step's own text verbatim when IT is the one
 *  that ended the call; otherwise an earlier step's text (the only text
 *  there is), prefixed to say the final step itself was silent. Empty
 *  when no step ever produced any text. */
export function resultText(finalText: string, lastStepHadText: boolean): string {
  if (!finalText) return "";
  return lastStepHadText ? finalText : `(final step had no text; last text was:)\n\n${finalText}`;
}
