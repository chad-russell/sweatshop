/**
 * 0090 §6: the `?prompt=` handoff — a link (e.g. the skills page's
 * "write a skill for …") lands on / with the composer prefilled. The
 * text is initial input only, NEVER auto-sent; capped for sanity.
 */
export function promptPrefill(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 2000) : undefined;
}
