"use client";

import { ChevronDown, Clock, ExternalLink, FileDiff, GitMerge, GitPullRequest, GitPullRequestClosed, type LucideIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { mergeBreakdowns, prUrlCoords, type DisplayWorkPR, type WorkPRDisplayState } from "@/lib/work-prs";
import { cn } from "@/lib/utils";

/**
 * 0078: the header's work pill — one PR status + diff breakdown control
 * for the whole thread, however many create_pr calls it made. Replaces
 * the separate PhaseChip(pr-open) + DiffBreakdownChip(header) pairing:
 * the per-category breakdown Chad relies on survives as the aggregate
 * (`mergeBreakdowns`) in the SAME popover as the PR list.
 */

const STATE_WORD: Record<WorkPRDisplayState, string> = {
  pending: "needs you",
  open: "open",
  merged: "merged",
  closed: "closed",
};

/** Most-attention-needing first: a pill covering several PRs shows the
 *  worst (most urgent) state's colour. */
const STATE_RANK: Record<WorkPRDisplayState, number> = { pending: 3, open: 2, merged: 1, closed: 0 };

/** The state as a glyph, not a dot — the shape says open / merged /
 *  closed at a glance, the token colour backs it up. */
const STATE_ICON: Record<WorkPRDisplayState, { icon: LucideIcon; className: string }> = {
  pending: { icon: Clock, className: "text-warning" },
  open: { icon: GitPullRequest, className: "text-info" },
  merged: { icon: GitMerge, className: "text-success" },
  closed: { icon: GitPullRequestClosed, className: "text-muted-foreground" },
};

function StateIcon({ state, className }: { state: WorkPRDisplayState; className?: string }) {
  const { icon: Icon, className: tone } = STATE_ICON[state];
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", tone, className)} />;
}

function worstState(prs: readonly DisplayWorkPR[]): WorkPRDisplayState {
  return prs.reduce<WorkPRDisplayState>(
    (worst, pr) => (STATE_RANK[pr.displayState] > STATE_RANK[worst] ? pr.displayState : worst),
    "closed",
  );
}

function prLabel(pr: DisplayWorkPR): string {
  if (pr.title) return pr.title;
  return pr.state === "pending" ? "Opening pull request…" : "Pull request";
}

/** 0 PRs renders nothing — the outline chip owns the header in that case. */
export function WorkPill({ prs }: { prs: readonly DisplayWorkPR[] }) {
  if (prs.length === 0) return null;
  const single = prs.length === 1 ? prs[0]! : null;
  const state = single ? single.displayState : worstState(prs);
  const merged = mergeBreakdowns(prs.map((pr) => pr.breakdown).filter((b) => b !== undefined));
  const showDiff = merged !== null && merged.files > 0;
  const singleCoords = single?.url ? prUrlCoords(single.url) : null;
  const singleNumber = singleCoords?.number ?? (single?.number !== undefined ? String(single.number) : undefined);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={single ? `Pull request ${STATE_WORD[state]}` : `${prs.length} pull requests, ${STATE_WORD[state]} needs the most attention`}
          className="inline-flex h-8 pointer-coarse:h-10 shrink-0 items-center gap-2 rounded-lg border border-border px-2.5 text-sm whitespace-nowrap transition-colors hover:bg-muted"
        >
          <StateIcon state={state} />
          {single ? (
            <span className="flex items-center gap-1">
              {singleNumber && <span className="font-mono text-xs text-muted-foreground max-sm:hidden">#{singleNumber}</span>}
              <span>{STATE_WORD[state]}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <span className="max-sm:hidden">{prs.length} PRs</span>
              <span className="sm:hidden">{prs.length}</span>
            </span>
          )}
          {showDiff && (
            <>
              <span aria-hidden className="h-4 w-px bg-border" />
              <span className="flex items-center gap-1 font-mono text-xs">
                <FileDiff className="size-3.5 text-muted-foreground max-sm:hidden" aria-hidden />
                <span className="text-muted-foreground max-sm:hidden">{merged.files} files</span>
                <span className="text-success">+{merged.added}</span>
                <span className="text-destructive">−{merged.deleted}</span>
              </span>
            </>
          )}
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-1.5">
          {prs.map((pr) => {
            const coords = pr.url ? prUrlCoords(pr.url) : null;
            const repo = coords?.repo ?? pr.repo;
            const number = coords?.number ?? (pr.number !== undefined ? String(pr.number) : undefined);
            return (
              <div key={pr.toolCallId} className="flex items-start gap-2 border-b border-border/50 pb-1.5 last:border-0 last:pb-0">
                <StateIcon state={pr.displayState} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  {(repo || number) && (
                    <div className="font-mono text-[11px] text-muted-foreground">
                      {[repo, number && `#${number}`].filter(Boolean).join(" ")}
                    </div>
                  )}
                  <div className="truncate text-sm">{prLabel(pr)}</div>
                  {pr.breakdown && (
                    <div className="font-mono text-[10px] text-muted-foreground">
                      <span className="text-success">+{pr.breakdown.added}</span> <span className="text-destructive">−{pr.breakdown.deleted}</span>
                    </div>
                  )}
                </div>
                {pr.url ? (
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="View PR"
                    className="mt-0.5 shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                ) : (
                  <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">awaiting approval</span>
                )}
              </div>
            );
          })}
        </div>
        {showDiff && (
          <table className="mt-2 w-full text-xs">
            <tbody>
              {merged.categories.map((category) => (
                <tr key={category.key} className="border-b border-border/50 last:border-0">
                  <td className="py-1 pr-2">{category.label}</td>
                  <td className="py-1 pr-2 text-right text-muted-foreground">{category.files}</td>
                  <td className="py-1 pr-1 text-right text-success">+{category.added}</td>
                  <td className="py-1 text-right text-destructive">−{category.deleted}</td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="py-1 pr-2">Total</td>
                <td className="py-1 pr-2 text-right text-muted-foreground">{merged.files}</td>
                <td className="py-1 pr-1 text-right text-success">+{merged.added}</td>
                <td className="py-1 text-right text-destructive">−{merged.deleted}</td>
              </tr>
            </tbody>
          </table>
        )}
      </PopoverContent>
    </Popover>
  );
}
