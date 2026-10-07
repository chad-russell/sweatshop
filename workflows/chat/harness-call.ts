import type { HarnessWorkflowState } from "@ai-sdk/workflow-harness";
import type { HarnessRoute } from "../../lib/providers/route";
import { harnessAdvanceStep, harnessSettleStep } from "./harness-step";

/**
 * 0022 cut 2: the background harness call worker — one workflow run per
 * chat pi/claude call. The body is pure orchestration (the workflow
 * transform forbids Node here): one `harnessAdvanceStep` per semantic
 * agent step (the 0009 grain — crash-resumable at that boundary), then
 * one `harnessSettleStep` that persists the resume handle, settles the
 * harness_calls row, releases the one-per-session slot, and wakes the
 * conversation with the final text.
 *
 * The initial state is built inline (the run-machine trick) so the
 * bundle stays free of runtime harness imports; `resumeFrom` arrives in
 * the input as plain data (the starter read it from chat_harness_state).
 */

const MAX_STEPS = 200;

export interface HarnessCallInput {
  callId: string;
  conversationId: string;
  kind: "pi" | "claude";
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
  let toolCalls = 0;
  let steps = 0;
  // do…while: the fresh state is "not_started", so a plain while never
  // ran the harness at all and every call "completed" in 0 s with no
  // output (caught live 2026-10-07). Same shape as run-machine's loop.
  do {
    const r = await harnessAdvanceStep({ callId, conversationId, kind, route, state });
    state = r.state;
    if (r.text) text += (text ? "\n\n" : "") + r.text;
    toolCalls += r.toolCalls;
    steps += 1;
  } while (state.status === "ready_for_next_step" && steps < MAX_STEPS);

  if (state.status === "failed") {
    await harnessSettleStep({
      callId,
      conversationId,
      kind,
      status: "failed",
      text,
      toolCalls,
      error: state.error ?? `${kind} turn failed`,
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
      toolCalls,
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
      toolCalls,
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
    toolCalls,
    resumeFrom: state.resumeFrom,
  });
  return { status: "completed" };
}
