/**
 * Ticket mode (0055): enter_mode / advance_phase steps. Split like the
 * other step files — every function keeps its "use step" directive;
 * Node/sqlite imports stay lazy inside each step body, and relative
 * imports stay relative (the workflow bundle has no "@/" alias).
 */

export async function enterModePreviewStep(
  conversationId: string,
  input: { mode: string; ticket: string; reason: string },
): Promise<unknown> {
  "use step";
  const { enterModePreview } = await import("../../../lib/agent/tools/modes");
  return enterModePreview(conversationId, input);
}

export async function applyEnterModeStep(conversationId: string, ticket: string): Promise<unknown> {
  "use step";
  const { applyEnterMode } = await import("../../../lib/agent/tools/modes");
  return applyEnterMode(conversationId, ticket);
}

export async function advancePhaseStep(conversationId: string, to: string, note?: string): Promise<unknown> {
  "use step";
  const { advancePhase } = await import("../../../lib/agent/tools/modes");
  return advancePhase(conversationId, to, note);
}
