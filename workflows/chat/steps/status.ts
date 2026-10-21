/**
 * 0059: update_status. Thin step — the core is lib/agent/tools/status.ts.
 * "use step" stays on the function; the workflow bundle has no "@/" alias.
 */

export async function updateStatusStep(input: { steps: unknown; note?: string }): Promise<unknown> {
  "use step";
  const { updateStatus } = await import("../../../lib/agent/tools/status");
  return updateStatus(input);
}
