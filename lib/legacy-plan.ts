/** Read-only compatibility shape for historical present_plan results. */
export interface LegacyPlanSnapshot { ok: true; version: number; markdown: string; status?: string; note?: string }
export function isLegacyPlanSnapshot(value: unknown): value is LegacyPlanSnapshot {
  const row = value as Partial<LegacyPlanSnapshot> | null;
  return !!row && row.ok === true && typeof row.version === "number" && typeof row.markdown === "string";
}
