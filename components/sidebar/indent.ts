/**
 * 0089: the one indent rule for every sidebar tree row —
 * `[depth × INDENT][handle slot][chevron slot][icon][label]`. Slots are
 * always reserved (empty when a row has no handle / no children) so rows at
 * the same depth line up, and a child's chevron sits under its parent's icon.
 * Pure pixel math; the Tailwind classes below must match these numbers.
 */

/** Pixels of left offset per nesting level. */
export const INDENT = 12;
/** A row's own left padding (Tailwind `px-2`). */
export const ROW_PAD = 8;
/** Handle and chevron slot width (Tailwind `w-3`). */
export const SLOT = 12;
/** Gap between grid cells (Tailwind `gap-1.5`). */
export const GAP = 6;

/** Class for the reserved drag-handle slot (kept on touch, where the handle itself is hidden). */
export const HANDLE_SLOT = "inline-flex w-3 shrink-0 items-center justify-center";
/** Class for the reserved chevron slot. */
export const CHEVRON_SLOT = "inline-flex w-3 shrink-0 items-center justify-center";

/** Left padding of a row at `depth`: where its handle slot starts. */
export function rowInset(depth: number): number {
  return ROW_PAD + depth * INDENT;
}

/** Left edge of a row's icon/label column — where its text starts. */
export function labelInset(depth: number): number {
  return rowInset(depth) + 2 * (SLOT + GAP);
}

/** Horizontal centre of a row's chevron slot (a thread guide line's x). */
export function guideLeft(depth: number): number {
  return rowInset(depth) + SLOT + GAP + SLOT / 2;
}
