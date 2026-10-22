/**
 * 0064: outline steps. Thin wrappers — the core is
 * lib/agent/tools/outline.ts. "use step" stays on the function; the
 * workflow bundle has no "@/" alias.
 */

/** update_outline: rewrite the outline (+ open a review when proposed). */
export async function updateOutlineStep(
  conversationId: string,
  toolCallId: string,
  input: unknown,
  live: import("ai").ModelMessage[],
): Promise<unknown> {
  "use step";
  const { updateOutline } = await import("../../../lib/agent/tools/outline");
  return updateOutline(conversationId, toolCallId, input as Record<string, unknown>, live);
}

/** accept_outline's preview — the open review it would approve. */
export async function acceptOutlinePreviewStep(conversationId: string): Promise<unknown> {
  "use step";
  const { acceptOutlinePreview } = await import("../../../lib/agent/tools/outline");
  return acceptOutlinePreview(conversationId);
}

/** Chad approved accept_outline — resolve the review it named. */
export async function acceptOutlineApprovedStep(rowId: string, comment?: string): Promise<unknown> {
  "use step";
  const { acceptOutlineApproved } = await import("../../../lib/agent/tools/outline");
  return acceptOutlineApproved(rowId, comment);
}
