import { CircleAlert, CircleSlash, CircleX, Hand, Loader2 } from "lucide-react";
import { cn } from "cn";

/** 0012: statuses where a run is still working (trash cancels it).
 * 0046: synthetic harness rows share the treatment — a running harness
 *  call keeps its parent's tree live. */
const LIVE = new Set(["running", "waiting"]);

export function isLiveRun(item: { kind: string; runStatus?: string | null }): boolean {
  return (item.kind === "run" || item.kind === "harness") && LIVE.has(item.runStatus ?? "");
}

/**
 * A run row's status at a glance: spinning while running, a hand at a
 * human gate, then its outcome. The attention dot still carries
 * unread / needs-you; this says what the run is doing. 0046: completed
 * shows no glyph — done is the quiet default, only work and trouble mark.
 */
export function RunGlyph({ status, className }: { status: string | null; className?: string }) {
  const base = cn("size-3.5 shrink-0", className);
  switch (status) {
    case "running":
      return <Loader2 aria-label="Running" className={cn(base, "animate-spin text-info")} />;
    case "waiting":
      return <Hand aria-label="Waiting for you" className={cn(base, "text-warning")} />;
    case "needs-attention":
      return <CircleAlert aria-label="Needs attention" className={cn(base, "text-warning")} />;
    case "completed":
      return null;
    case "failed":
      return <CircleX aria-label="Failed" className={cn(base, "text-destructive")} />;
    default:
      return <CircleSlash aria-label="Cancelled" className={cn(base, "text-sidebar-foreground/60")} />;
  }
}
