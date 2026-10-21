import type { HarnessWorkflowState } from "@ai-sdk/workflow-harness";
import type { HarnessRoute } from "../../lib/providers/route";
import { harnessAdvanceStep, harnessSettleStep } from "./harness-step";

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
 */

const MAX_STEPS = 200;

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
}

export async function harnessCall(input: HarnessCallInput): Promise<{ status: string }> {
  "use workflow";
  const { callId, conversationId, kind, task, route } = input;

  let state = {
    sessionId: conversationId,
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
  // do…while: the fresh state is "not_started", so a plain while never
  // ran the harness at all and every call "completed" in 0 s with no
  // output (caught live 2026-10-07). Same shape as run-machine's loop.
  try {
    do {
      const r = await harnessAdvanceStep({
        callId,
        conversationId,
        kind,
        route,
        state,
        totals: { usage, steps, toolCalls, reportedCostUsd },
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
      }
    } while (state.status === "ready_for_next_step" && steps < MAX_STEPS);
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
      status: "failed",
      text,
      finalText: resultText(finalText, lastStepHadText),
      toolCalls,
      steps,
      route,
      usage,
      reportedCostUsd,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "failed" };
  }

  if (state.status === "failed") {
    await harnessSettleStep({
      callId,
      conversationId,
      kind,
      status: "failed",
      text,
      finalText: resultText(finalText, lastStepHadText),
      toolCalls,
      steps,
      route,
      usage,
      reportedCostUsd,
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
      status: "failed",
      text,
      finalText: resultText(finalText, lastStepHadText),
      toolCalls,
      steps,
      route,
      usage,
      reportedCostUsd,
      error: "harness requested a tool approval (unsupported in v1)",
    });
    return { status: "failed" };
  }
  if (state.status === "ready_for_next_step") {
    await harnessSettleStep({
      callId,
      conversationId,
      kind,
      status: "failed",
      text,
      finalText: resultText(finalText, lastStepHadText),
      toolCalls,
      steps,
      route,
      usage,
      reportedCostUsd,
      error: `exceeded ${MAX_STEPS} agent steps`,
    });
    return { status: "failed" };
  }

  // finished
  await harnessSettleStep({
    callId,
    conversationId,
    kind,
    status: "completed",
    text,
    finalText: resultText(finalText, lastStepHadText),
    toolCalls,
    steps,
    route,
    usage,
    reportedCostUsd,
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
