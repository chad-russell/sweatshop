"use client";

import { Pill } from "@/components/ai-elements/agent-cards";
import type { Phase } from "@/lib/thread-phase";
import { cn } from "@/lib/utils";

/** 0078: the outline chip only — a PR's own status lives in the work
 *  pill (components/work-pill.tsx) beside this, never inside it. */
export function PhaseChip({ phase, variant = "compact", className }: { phase: Phase | null; variant?: "header" | "compact"; className?: string }) {
  if (!phase) return null;
  if (variant === "compact") {
    return <span className={cn("shrink-0", className)}><Pill tone={phase.tone} label={phase.stale ? `${phase.label} · stale` : phase.label} /></span>;
  }
  const base = cn("inline-flex h-8 pointer-coarse:h-10 shrink-0 items-center gap-2 rounded-lg border px-2.5 text-sm whitespace-nowrap", phase.tone === "running" && "border-info/30 bg-info/10 text-info", phase.tone === "ok" && "border-success/30 bg-success/10 text-success", phase.tone === "warn" && "border-warning/30 bg-warning/10 text-warning", className);
  return (
    <span className={base}>
      <span aria-hidden className={cn("size-1.5 rounded-full bg-current", phase.tone === "running" && "animate-pulse")} />
      {phase.label}
      {phase.stale && <span className="font-normal text-muted-foreground" title="The outline wasn't updated after the last wake">stale</span>}
    </span>
  );
}
