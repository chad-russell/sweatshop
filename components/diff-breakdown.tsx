"use client";

import { FileDiff } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DiffBreakdown } from "@/lib/diff-breakdown";
import { cn } from "@/lib/utils";

/**
 * 0059: where a branch's diff actually lives — a chip ("N files +A −D")
 * that opens a popover with the per-category table (Generated / Tests /
 * Docs / Migrations / Config / Code, plus a Total row). `compact` (the
 * default) is the small pill shared by the create_pr approval cards and
 * the transcript's PullRequestToolCard; `header` matches PhaseChip's
 * header pill, for the thread header once a PR is open.
 */
export function DiffBreakdownChip({
  breakdown,
  variant = "compact",
}: {
  breakdown: DiffBreakdown;
  variant?: "compact" | "header";
}) {
  if (breakdown.files === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={
            variant === "header"
              ? "inline-flex h-8 pointer-coarse:h-10 shrink-0 items-center gap-2 rounded-lg border border-border px-2.5 text-sm whitespace-nowrap transition-colors hover:bg-muted"
              : "inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          }
        >
          <FileDiff className={cn("shrink-0", variant === "header" ? "size-3.5" : "size-3")} aria-hidden />
          {breakdown.files} files
          <span className="text-success">+{breakdown.added}</span>
          <span className="text-destructive">−{breakdown.deleted}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align={variant === "header" ? "end" : "start"} className="w-64">
        <table className="w-full text-xs">
          <tbody>
            {breakdown.categories.map((category) => (
              <tr key={category.key} className="border-b border-border/50 last:border-0">
                <td className="py-1 pr-2">{category.label}</td>
                <td className="py-1 pr-2 text-right text-muted-foreground">{category.files}</td>
                <td className="py-1 pr-1 text-right text-success">+{category.added}</td>
                <td className="py-1 text-right text-destructive">−{category.deleted}</td>
              </tr>
            ))}
            <tr className="font-medium">
              <td className="py-1 pr-2">Total</td>
              <td className="py-1 pr-2 text-right text-muted-foreground">{breakdown.files}</td>
              <td className="py-1 pr-1 text-right text-success">+{breakdown.added}</td>
              <td className="py-1 text-right text-destructive">−{breakdown.deleted}</td>
            </tr>
          </tbody>
        </table>
      </PopoverContent>
    </Popover>
  );
}
