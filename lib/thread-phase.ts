import type { UIMessage } from "ai";
import { deriveOutline, outlineChip } from "./outline";

export interface Phase { label: string; tone: "warn" | "running" | "ok"; url?: string; kind?: "pr-open"; stale?: boolean }
export interface PRState { state: "open" | "merged" | "closed"; mergedAt?: string }

export function applyPRState(phase: Phase | null, live: PRState | null): Phase | null {
  if (!phase || phase.kind !== "pr-open" || !live) return phase;
  if (live.state === "merged") return { ...phase, label: "PR merged", tone: "ok" };
  if (live.state === "closed") return { ...phase, label: "PR closed", tone: "warn" };
  return phase;
}

type LoosePart = { type: string; state?: string; output?: unknown };

/** PR state wins; otherwise the current outline owns the header chip. */
export function phaseFromMessages(messages: readonly UIMessage[]): Phase | null {
  let pr: Phase | null = null;
  for (const message of messages) for (const raw of message.parts) {
    const part = raw as LoosePart;
    if (part.type !== "tool-create_pr") continue;
    if (part.state === "input-available") pr = { label: "PR · needs you", tone: "warn" };
    else if (part.state === "output-available") {
      const url = (part.output as { url?: unknown } | undefined)?.url;
      pr = typeof url === "string" ? { label: "PR open", tone: "ok", kind: "pr-open", url } : null;
    } else if (part.state === "output-error") pr = null;
  }
  if (pr) return pr;
  const outline = deriveOutline(messages);
  const chip = outlineChip(outline);
  return chip ? { ...chip, ...(outline.stale ? { stale: true } : {}) } : null;
}
