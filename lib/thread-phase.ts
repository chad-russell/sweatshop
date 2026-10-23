import type { UIMessage } from "ai";
import { deriveOutline, outlineChip } from "./outline";

export interface Phase { label: string; tone: "warn" | "running" | "ok"; stale?: boolean }

/** 0078: the outline owns the header chip now — a PR lives in the work
 *  pill instead (lib/work-prs.ts), never in the phase. */
export function phaseFromMessages(messages: readonly UIMessage[]): Phase | null {
  const outline = deriveOutline(messages);
  const chip = outlineChip(outline);
  return chip ? { ...chip, ...(outline.stale ? { stale: true } : {}) } : null;
}
