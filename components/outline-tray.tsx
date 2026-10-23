"use client";

import { ChevronDown } from "lucide-react";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import { OutlineBody, type OutlineBodyView, type OutlineSavedEdit } from "@/components/outline-card";
import { outlineTraySummary, type OutlineState, type OutlineTrayContext } from "@/lib/outline";
import { cn } from "@/lib/utils";

/**
 * 0079: the always-visible outline — a one-line bar docked to the top
 * of the composer (collapsed, the default) that expands UPWARD into
 * the full checklist, reusing `OutlineBody` (the same document + edit +
 * approve flow as the transcript's own card, 0064). Chad's ask: see
 * progress/status at any point in the chat, not only wherever an
 * update_outline tool card happens to sit in the transcript. Renders
 * nothing before the thread's first `update_outline` call — the
 * outline-free header chrome is unchanged.
 */

const TRAY_PREFIX = "sweatshop.outline-tray.";

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode etc. — the tray still works per-tab */
  }
}

const emptySubscribe = () => () => {};

/** SSR-safe read of the stored expanded preference (same
 *  `useSyncExternalStore` shape as lib/use-mounted.ts): the server and
 *  first client paint both see `false`, so there is no hydration
 *  mismatch to warn about — React reconciles to the real stored value
 *  right after mount. */
function useStoredExpanded(key: string): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => stored(key) === "1",
    () => false,
  );
}

const SEGMENT_CLASS: Record<OutlineState, string> = {
  done: "bg-success",
  active: "bg-info",
  blocked: "bg-warning",
  pending: "bg-muted-foreground/40",
  skipped: "bg-muted-foreground/40",
};

export function OutlineTray({
  conversationId,
  projectId,
  quote,
  context,
  busy,
}: {
  conversationId: string;
  projectId: string | null;
  quote?: (text: string) => void;
  /** Null before any update_outline call — the tray renders nothing. */
  context: OutlineTrayContext | null;
  /** Gates the active segment's pulse — quiet while nothing is running. */
  busy: boolean;
}) {
  const storageKey = `${TRAY_PREFIX}${conversationId}`;
  const storedExpanded = useStoredExpanded(storageKey);
  // The user's in-session toggle wins once set; otherwise the stored
  // preference (itself SSR-safe — see useStoredExpanded). Caller keys
  // this component by conversationId so switching chats remounts it,
  // resetting this override cleanly instead of carrying it across.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = toggled ?? storedExpanded;
  const [saved, setSaved] = useState<OutlineSavedEdit | null>(null);
  const bodyId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  const setExpandedAndStore = (value: boolean) => {
    setToggled(value);
    store(storageKey, value ? "1" : "0");
  };

  if (!context) return null;
  const { current, previous, openReviewId, approved, stale } = context;
  const savedActive = saved !== null && saved.version >= current.version;
  const outline = savedActive ? saved.outline : current.outline;
  const version = savedActive ? saved.version : current.version;
  const open = savedActive ? !saved.approved : openReviewId !== null;
  const reviewId = savedActive ? saved.reviewId : (openReviewId ?? "");
  const canEditApprovedRunners = (savedActive ? saved.approved : approved) && outline.steps.some((step) => step.state === "pending");
  const summary = outlineTraySummary(outline, open);
  const view: OutlineBodyView = { conversationId, projectId, quote };

  return (
    <div
      className="outline-tray flex flex-col overflow-hidden rounded-t-2xl border border-b-0 border-border bg-card"
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          setExpandedAndStore(false);
          toggleRef.current?.focus();
        }
      }}
    >
      {expanded && (
        <div id={bodyId} className="max-h-[min(50dvh,28rem)] overflow-y-auto border-b border-border px-3 py-3">
          <OutlineBody
            outline={outline}
            version={version}
            previous={previous}
            open={open}
            reviewId={reviewId}
            canEditReview={open}
            canEditApprovedRunners={canEditApprovedRunners}
            view={view}
            onSaved={setSaved}
          />
        </div>
      )}
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpandedAndStore(!expanded)}
        className="flex h-9 w-full items-center gap-2 px-3 text-sm transition-colors hover:bg-muted/50 pointer-coarse:h-10"
      >
        <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
          {summary.segments.map((segment) => (
            <span
              key={segment.id}
              className={cn("h-1.5 w-4 rounded-full", SEGMENT_CLASS[segment.state], segment.state === "active" && busy && "animate-pulse")}
            />
          ))}
        </span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {summary.done}/{summary.total}
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{summary.label}</span>
        {summary.needsYou && <span className="shrink-0 text-xs font-medium text-warning">needs you</span>}
        {stale && (
          <span className="shrink-0 text-xs text-muted-foreground" title="The outline wasn't updated after the last wake">
            stale
          </span>
        )}
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} aria-hidden />
      </button>
    </div>
  );
}
