"use client";

import { Pill } from "@/components/ai-elements/agent-cards";
import type { Phase } from "@/lib/thread-phase";
import { cn } from "@/lib/utils";

/** 0079: the compact outline chip — used only by the agent panel's
 *  slim header now that the main chat header's outline chip and "needs
 *  you"/stale indicators moved into the composer-docked outline tray
 *  (components/outline-tray.tsx). A PR's own status lives in the work
 *  pill (components/work-pill.tsx), never in here. */
export function PhaseChip({ phase, className }: { phase: Phase | null; className?: string }) {
  if (!phase) return null;
  return (
    <span className={cn("shrink-0", className)}>
      <Pill tone={phase.tone} label={phase.stale ? `${phase.label} · stale` : phase.label} />
    </span>
  );
}
