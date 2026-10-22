"use client";

import { ExternalLink } from "lucide-react";
import { Pill } from "@/components/ai-elements/agent-cards";
import type { Phase } from "@/lib/thread-phase";
import { cn } from "@/lib/utils";

export function PhaseChip({ phase, variant = "compact", className }: { phase: Phase | null; variant?: "header" | "compact"; className?: string }) {
  if (!phase) return null;
  if (variant === "compact") {
    const pill = <Pill tone={phase.tone} label={phase.stale ? `${phase.label} · stale` : phase.label} />;
    return phase.url ? <a href={phase.url} target="_blank" rel="noreferrer" className={cn("shrink-0", className)}>{pill}</a> : <span className={cn("shrink-0", className)}>{pill}</span>;
  }
  const base = cn("inline-flex h-8 pointer-coarse:h-10 shrink-0 items-center gap-2 rounded-lg border px-2.5 text-sm whitespace-nowrap", phase.tone === "running" && "border-info/30 bg-info/10 text-info", phase.tone === "ok" && "border-success/30 bg-success/10 text-success", phase.tone === "warn" && "border-warning/30 bg-warning/10 text-warning", className);
  const inner = <><span aria-hidden className={cn("size-1.5 rounded-full bg-current", phase.tone === "running" && "animate-pulse")} />{phase.label}{phase.stale && <span className="font-normal text-muted-foreground" title="The outline wasn't updated after the last wake">stale</span>}</>;
  return phase.url ? <a href={phase.url} target="_blank" rel="noreferrer" className={cn(base, "transition-colors hover:bg-success/20")}>{inner}<ExternalLink className="size-3.5" aria-hidden /></a> : <span className={base}>{inner}</span>;
}
