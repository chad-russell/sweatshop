import { cn } from "cn";

/**
 * The one attention signal, everywhere in the tree: a filled dot for
 * unread output, an amber one when something is waiting on an answer
 * (needs-you outranks unread). `count` rolls up a collapsed container.
 */
export function AttentionDot({
  unread,
  needsYou,
  className,
}: {
  unread: number;
  needsYou: number;
  className?: string;
}) {
  if (unread === 0 && needsYou === 0) return null;
  const waiting = needsYou > 0;
  const count = waiting ? needsYou : unread;
  return (
    <span
      role="img"
      aria-label={waiting ? `${needsYou} waiting on you` : `${unread} unread`}
      title={waiting ? `${needsYou} waiting on you` : `${unread} unread`}
      className={cn("inline-flex shrink-0 items-center gap-1", className)}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          waiting ? "bg-warning" : "bg-sidebar-primary",
        )}
      />
      {count > 1 && (
        <span className="font-mono text-[10px] leading-none text-sidebar-foreground/70">
          {count}
        </span>
      )}
    </span>
  );
}
