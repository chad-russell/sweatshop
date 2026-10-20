"use client";

import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import { useState } from "react";
import { LocalTime } from "@/components/local-time";
import { NavTrigger } from "@/components/sidebar/nav-drawer";
import { cn } from "@/lib/utils";
import type { DashboardPR, PRDashboardData } from "@/lib/read-models/prs";

/**
 * The PR dashboard (0053): every PR by Chad's accounts across project
 * repos — open first in needs-attention order, settled dimmed below.
 * The page load is the fetch (ask the host on view, store nothing);
 * a refresh re-asks.
 */

/** Settled rows shown before the "+N more" toggle. */
const SETTLED_SHOWN = 10;

/** owner/repo off a PR web URL — the row's repo badge. */
function repoOf(url: string): string | null {
  const match = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pulls?\//);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** ISO → ms, or null (an unparseable timestamp renders no time at all). */
const at = (iso: string): number | null => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-baseline gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
        <span className="font-mono">{count}</span>
      </h2>
      {children}
    </section>
  );
}

/** The lifecycle icon — approvals.tsx's PR vocabulary (0052), token-toned. */
function StateIcon({ state }: { state: DashboardPR["state"] }) {
  if (state === "merged") {
    return <GitMerge className="mt-0.5 size-4 shrink-0 text-success" aria-label="Merged" />;
  }
  if (state === "closed") {
    return <GitPullRequestClosed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Closed" />;
  }
  return <GitPullRequest className="mt-0.5 size-4 shrink-0 text-info" aria-label="Open" />;
}

/** The review badge: a verdict when there is one, else the comment count. */
function ReviewBadge({ pr }: { pr: DashboardPR }) {
  if (pr.reviewState === "changes-requested") {
    return (
      <span
        title={pr.lastReviewAt ? `last review ${pr.lastReviewAt}` : undefined}
        className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning"
      >
        changes requested
      </span>
    );
  }
  if (pr.reviewState === "approved") {
    return (
      <span
        title={pr.lastReviewAt ? `last review ${pr.lastReviewAt}` : undefined}
        className="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"
      >
        approved
      </span>
    );
  }
  if ((pr.commentCount ?? 0) > 0) {
    return <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{pr.commentCount} comments</span>;
  }
  return null;
}

function PRRow({ pr, settled }: { pr: DashboardPR; settled: boolean }) {
  const repo = repoOf(pr.url);
  const updatedAt = at(pr.updatedAt);
  return (
    <article
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-muted/40",
        settled && "opacity-60",
      )}
    >
      <StateIcon state={pr.state} />
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
      >
        {pr.title}
      </a>
      {repo && <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">{repo}</span>}
      <span className="hidden shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground md:inline">
        {pr.head}
      </span>
      <ReviewBadge pr={pr} />
      {updatedAt !== null && (
        <LocalTime ms={updatedAt} className="shrink-0 text-xs text-muted-foreground" />
      )}
    </article>
  );
}

export function PRDashboard({ data }: { data: PRDashboardData }) {
  const [showAllSettled, setShowAllSettled] = useState(false);
  const open = data.prs.filter((pr) => pr.state === "open");
  const settled = data.prs.filter((pr) => pr.state !== "open");
  const settledShown = showAllSettled ? settled : settled.slice(0, SETTLED_SHOWN);

  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col gap-8 overflow-y-auto p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <NavTrigger className="-ml-2" />
          <GitPullRequest className="size-5" />
          PRs
        </h1>
        <p className="text-xs text-muted-foreground">
          Every PR by your accounts in project repos — asked live across{" "}
          {data.reposQueried} repo{data.reposQueried === 1 ? "" : "s"}, stored nothing (refresh re-asks).
        </p>
      </header>

      {data.failedRepos.length > 0 && (
        <div
          role="note"
          className="flex flex-col gap-0.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {data.failedRepos.map((failed) => (
            <p key={failed.repo}>
              <span className="font-mono">{failed.repo}</span>: {failed.reason}
            </p>
          ))}
        </div>
      )}

      {data.prs.length === 0 && (
        <p className="text-sm text-muted-foreground">No PRs by your accounts in project repos.</p>
      )}

      {open.length > 0 && (
        <Section title="Open" count={open.length}>
          {open.map((pr) => (
            <PRRow key={pr.url} pr={pr} settled={false} />
          ))}
        </Section>
      )}

      {settled.length > 0 && (
        <Section title="Settled" count={settled.length}>
          {settledShown.map((pr) => (
            <PRRow key={pr.url} pr={pr} settled />
          ))}
          {/* Shown whenever there is anything hidden — the button both
              expands and collapses (the old "more > 0" test could never
              be false once expanded, so "Show fewer" was unreachable). */}
          {settled.length > SETTLED_SHOWN && (
            <button
              type="button"
              onClick={() => setShowAllSettled(!showAllSettled)}
              className="self-start rounded-md border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {showAllSettled ? "Show fewer" : `+${settled.length - SETTLED_SHOWN} more`}
            </button>
          )}
        </Section>
      )}
    </div>
  );
}
