/**
 * Child runs: cancel_run, start_thread, wake-parent. Split from the old single steps.ts - every function
 * keeps its "use step" directive; Node/sqlite imports stay lazy inside
 * each step body, and relative imports stay relative (the workflow
 * bundle has no "@/" alias).
 */

/** 0022: cancel a run the agent started (or watches). */
export async function cancelRunStep(runId: string): Promise<unknown> {
  "use step";
  const { cancelRunTool } = await import("../../../lib/agent/tools/cancel-run");
  return cancelRunTool(runId);
}

/** 0037 phase 3: start a fresh child thread (its own context, this
 *  sandbox by default) that wakes this conversation when it settles. */
export async function startThreadStep(
  conversationId: string,
  input: { prompt: string; skill?: string; fresh?: boolean; phase?: string },
): Promise<unknown> {
  "use step";
  const { startThread } = await import("../../../lib/agent/tools/start-thread");
  return startThread({ conversationId, ...input });
}

/** 0037 phase 3: at a turn's end — wake this thread's parent if this
 *  thread is a settled child (no-op for every other conversation; one
 *  select). Runs after the budget decision so a continuing child reads
 *  as still-working, and a bounded one still reports. */
export async function wakeParentStep(conversationId: string): Promise<"woke" | "skipped" | "none"> {
  "use step";
  const { wakeChatChildByIdIfDue } = await import("../../../lib/chat/wake");
  return wakeChatChildByIdIfDue(conversationId);
}
