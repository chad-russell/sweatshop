"use client";

import { Ban, Check, ChevronRight, Circle, CircleDot, Minus, Plus, Quote } from "lucide-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Card } from "@/components/ai-elements/agent-cards";
import {
  diffOutlineSteps,
  isOutline,
  isOutlineSnapshot,
  legacyOutlineFromStatus,
  runnerLabel,
  type Outline,
  type OutlineState,
  type OutlineStepDiff,
  type OutlineTranscriptHistory,
  type Step,
} from "@/lib/outline";
import { isStatusSnapshot } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * 0064: the outline card — grown from 0059's status-card.tsx. A goal
 * line, a recursive collapsible tree, a runner badge on each top-level
 * step (read-only in PR 1 — editing and runner enforcement are PR 2), a
 * "changes since vN" toggle diffed by step id, and Approve while a
 * proposed version is in review. Renders both the live `update_outline`
 * shape and a historical `update_status` snapshot (0064 decision 10: the
 * same read-only tree, adapted).
 */

const MARK: Record<OutlineState, { icon: typeof Check; className: string; label: string }> = {
  done: { icon: Check, className: "text-success", label: "done" },
  active: { icon: CircleDot, className: "text-info", label: "active" },
  pending: { icon: Circle, className: "text-muted-foreground", label: "pending" },
  skipped: { icon: Minus, className: "text-muted-foreground", label: "skipped" },
  blocked: { icon: Ban, className: "text-warning", label: "blocked" },
};

function RunnerBadge({ runner }: { runner: Step["runner"] }) {
  return (
    <span className="shrink-0 rounded-full border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {runnerLabel(runner)}
    </span>
  );
}

function diffFor(id: string, diff: readonly OutlineStepDiff[] | null): OutlineStepDiff | undefined {
  return diff?.find((d) => d.id === id);
}

function StepRow({
  step,
  topLevel,
  diff,
}: {
  step: Step;
  topLevel: boolean;
  diff: readonly OutlineStepDiff[] | null;
}) {
  const [open, setOpen] = useState(true);
  const mark = MARK[step.state];
  const Icon = mark.icon;
  const hasChildren = Boolean(step.children?.length);
  const mine = diffFor(step.id, diff);
  return (
    <li className="py-0.5 text-sm">
      <div className="flex items-start gap-1.5">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Collapse" : "Expand"}
            className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
          </button>
        ) : (
          <span className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        )}
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", mark.className)} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={cn(step.state === "done" || step.state === "skipped" ? "text-muted-foreground" : "text-foreground")}>
            {step.label}
          </span>
          <span className="sr-only"> ({mark.label})</span>
          {step.detail && <span className="text-muted-foreground"> — {step.detail}</span>}
          {mine && (
            <span
              className={cn(
                "ml-1.5 font-mono text-[10px]",
                mine.kind === "added" && "text-success",
                mine.kind === "removed" && "text-destructive",
                mine.kind === "state-changed" && "text-info",
              )}
            >
              {mine.kind === "added" ? (
                <Plus className="inline size-3" aria-hidden />
              ) : mine.kind === "removed" ? (
                "removed"
              ) : (
                `${mine.fromState} → ${mine.toState}`
              )}
            </span>
          )}
        </span>
        {topLevel && <RunnerBadge runner={step.runner} />}
      </div>
      {hasChildren && open && (
        <ul className="pl-5">
          {step.children!.map((child) => (
            <StepRow key={child.id} step={child} topLevel={false} diff={diff} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The goal + tree, with an optional "changes since vN" toggle. */
export function OutlineDocument({
  outline,
  previous,
  quote,
  className,
}: {
  outline: Outline;
  previous?: { version: number; outline: Outline } | null;
  quote?: (text: string) => void;
  className?: string;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const diff = useMemo(
    () => (showDiff && previous ? diffOutlineSteps(previous.outline, outline) : null),
    [showDiff, previous, outline],
  );
  const changed = diff ? diff.length : 0;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {outline.goal && <p className="text-sm font-medium">{outline.goal}</p>}
      {(previous || quote) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {previous && (
            <button
              type="button"
              onClick={() => setShowDiff((v) => !v)}
              className={cn(
                "rounded-md border px-2 py-1 font-medium transition-colors pointer-coarse:px-3 pointer-coarse:py-2",
                showDiff ? "border-ring bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {showDiff ? "Hide changes" : `Changes since v${previous.version}`}
            </button>
          )}
          {quote && (
            <button
              type="button"
              onClick={() => quote(outline.goal || outline.steps.map((s) => s.label).join(", "))}
              title="Quote the outline into your reply"
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium text-muted-foreground transition-colors hover:text-foreground pointer-coarse:px-3 pointer-coarse:py-2"
            >
              <Quote className="size-3" aria-hidden />
              Quote
            </button>
          )}
        </div>
      )}
      {showDiff && changed === 0 && <p className="text-xs text-muted-foreground">No changes.</p>}
      <ul>
        {outline.steps.map((step) => (
          <StepRow key={step.id} step={step} topLevel diff={showDiff ? diff : null} />
        ))}
      </ul>
      {outline.note && <p className="text-xs text-muted-foreground">{outline.note}</p>}
    </div>
  );
}

/** Approve (with an optional note) for an open outline review. */
export async function approveOutlineRequest(toolCallId: string, note?: string): Promise<string | null> {
  try {
    const res = await fetch("/api/x/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolCallId, approveOutline: true, ...(note ? { note } : {}) }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? `approve failed (${res.status})`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function OutlineApprove({
  toolCallId,
  version,
  onApproved,
  hint,
}: {
  toolCallId: string;
  version: number;
  onApproved?: () => void;
  hint?: ReactNode;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (done) return <p className="text-xs text-muted-foreground">Approved — the agent continues.</p>;
  const approve = async () => {
    setBusy(true);
    setError(null);
    const failure = await approveOutlineRequest(toolCallId, note.trim() || undefined);
    setBusy(false);
    if (failure) setError(failure);
    else {
      setDone(true);
      onApproved?.();
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note with the approval"
          disabled={busy}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-base pointer-coarse:h-10 md:text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter") void approve();
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void approve()}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
        >
          Approve v{version}
        </button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** What the session gives its outline cards: the transcript's outline
 *  history and the composer's quote hook (absent outside a chat). */
export interface OutlineView {
  history: OutlineTranscriptHistory;
  quote?: (text: string) => void;
}

const OutlineContext = createContext<OutlineView | null>(null);
export const OutlineViewProvider = OutlineContext.Provider;

/** The transcript's update_outline card — also renders a legacy
 *  update_status result (toolName tells us which). */
export function OutlineToolCard({
  toolCallId,
  toolName,
  state,
  output,
  errorText,
}: {
  toolCallId: string;
  toolName: "update_outline" | "update_status";
  state: string;
  output?: unknown;
  errorText?: string;
}) {
  const view = useContext(OutlineContext);
  const running = state === "input-streaming" || state === "input-available";
  if (running) return null; // no card while the rewrite streams in — nothing to show yet
  let outline: Outline | null = null;
  let version: number | null = null;
  let proposed = false;
  if (toolName === "update_outline" && isOutlineSnapshot(output)) {
    outline = output.outline;
    version = output.version;
    proposed = output.proposed;
  } else if (toolName === "update_status" && isStatusSnapshot(output)) {
    outline = legacyOutlineFromStatus(output);
  }
  if (!outline || !isOutline(outline)) {
    const failure = output as { message?: unknown } | undefined;
    const message = typeof failure?.message === "string" ? failure.message : (errorText ?? null);
    if (!message) return null;
    return <Card icon={Ban} title="Outline" subtitle="not updated" tone="fail" pill="failed" failed errorLines={[message]} />;
  }
  const latest = view ? view.history.latestId === toolCallId : true;
  const open = view?.history.openReviewId === toolCallId;
  const previous = view?.history.previous.get(toolCallId) ?? null;
  const pill = open ? "needs you" : proposed ? (latest ? "approved" : "superseded") : "recorded";
  const tone = open ? "warn" : proposed && !latest ? "neutral" : "ok";
  return (
    <Card
      icon={Check}
      title={version ? `Outline v${version}` : "Outline"}
      subtitle={outline.goal || undefined}
      tone={tone}
      pill={pill}
      defaultOpen={latest}
      className={cn(open && "border-warning/50")}
    >
      <div className="flex flex-col gap-3 p-3">
        <OutlineDocument outline={outline} previous={previous} quote={view?.quote} />
        {open && (
          <OutlineApprove
            toolCallId={toolCallId}
            version={version ?? 0}
            hint="Or just reply below — the agent revises and updates again. Typing never approves."
          />
        )}
      </div>
    </Card>
  );
}
