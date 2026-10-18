/**
 * Plan files (0041): present/accept steps. Split from the old single steps.ts - every function
 * keeps its "use step" directive; Node/sqlite imports stay lazy inside
 * each step body, and relative imports stay relative (the workflow
 * bundle has no "@/" alias).
 */


/** 0041: snapshot PLAN.md into the tool result (+ open the review row). */
export async function presentPlanStep(
  conversationId: string,
  toolCallId: string,
  input: { note?: string; reapprove?: boolean },
  live: import("ai").ModelMessage[],
): Promise<unknown> {
  "use step";
  const { presentPlan } = await import("../../../lib/agent/tools/plan");
  return presentPlan(conversationId, toolCallId, input, live);
}

/** 0041: accept_plan's preview — the open review it would approve. */
export async function acceptPlanPreviewStep(conversationId: string): Promise<unknown> {
  "use step";
  const { acceptPlanPreview } = await import("../../../lib/agent/tools/plan");
  return acceptPlanPreview(conversationId);
}

/** 0041: Chad approved accept_plan — resolve the review it named. */
export async function acceptPlanApprovedStep(rowId: string, comment?: string): Promise<unknown> {
  "use step";
  const { acceptPlanApproved } = await import("../../../lib/agent/tools/plan");
  return acceptPlanApproved(rowId, comment);
}
