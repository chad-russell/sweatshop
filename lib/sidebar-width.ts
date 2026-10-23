/**
 * Pure clamp/parse for the resizable sidebar's width
 * (components/sidebar/sidebar-resizer.tsx). Kept separate from the
 * component so the bounds are testable without a DOM.
 */
export const SIDEBAR_WIDTH_DEFAULT = 256;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;

export function clampSidebarWidth(px: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, px));
}

/** Parses a stored width, clamping it; null for anything unusable. */
export function parseSidebarWidth(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? clampSidebarWidth(n) : null;
}
