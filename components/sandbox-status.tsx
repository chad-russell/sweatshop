import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
  running: "text-success",
  creating: "text-info",
  stopped: "text-muted-foreground",
  destroyed: "text-muted-foreground line-through",
};

/** Sandbox lifecycle status, machine-voice (mono) with a state dot. */
export function SandboxStatus({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-xs", TONE[status], className)}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full bg-current",
          status === "creating" && "animate-pulse",
          status === "destroyed" && "opacity-40",
        )}
      />
      {status}
    </span>
  );
}
