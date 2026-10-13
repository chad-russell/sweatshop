"use client";

import { ClipboardList, Quote } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Card, Pill } from "@/components/ai-elements/agent-cards";
import { MessageResponse } from "@/components/ai-elements/message";
import { diffLines, isPlanSnapshot, type Phase, type PlanHistory } from "@/lib/plan";
import { cn } from "@/lib/utils";

/**
 * 0041: the plan card — a present_plan snapshot rendered as a document:
 * version, checklist count, "changes since vN" (a line diff against the
 * previous snapshot), Approve while the review is open, and Quote: the
 * selected text lands in the composer as a `>` block, so pointed
 * feedback is an ordinary message. Shared by the transcript and the
 * Inbox (which has no composer, so no Quote).
 */

/** What the session gives its plan cards: the transcript's plan history
 *  and the composer's quote hook (absent outside a chat). */
export interface PlanView {
  history: PlanHistory;
  quote?: (text: string) => void;
}

const PlanContext = createContext<PlanView | null>(null);
export const PlanViewProvider = PlanContext.Provider;

/** Approve the open review from a card (the plan row id = the call id). */
export async function approvePlanRequest(toolCallId: string, note?: string): Promise<string | null> {
  try {
    const res = await fetch("/api/x/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolCallId, approvePlan: true, ...(note ? { note } : {}) }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? `approve failed (${res.status})`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The text selected inside `root`, remembered across the tap that
 *  clears it (mobile: tapping Quote collapses the selection first). */
function useSelectionWithin(root: React.RefObject<HTMLElement | null>): string {
  const [text, setText] = useState("");
  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !root.current) return;
      const node = sel.anchorNode;
      if (node && root.current.contains(node)) setText(sel.toString().trim());
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [root]);
  return text;
}

export function quoteBlock(text: string): string {
  return `${text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n")}\n\n`;
}

/** The document body: markdown, or the diff against the previous version. */
export function PlanDocument({
  markdown,
  previous,
  quote,
  className,
}: {
  markdown: string;
  previous?: { version: number; markdown: string } | null;
  quote?: (text: string) => void;
  className?: string;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = useSelectionWithin(root);
  const diff = useMemo(() => (showDiff && previous ? diffLines(previous.markdown, markdown) : null), [showDiff, previous, markdown]);
  const changed = diff ? diff.filter((l) => l.op !== "same").length : 0;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
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
              {showDiff ? "Show document" : `Changes since v${previous.version}`}
            </button>
          )}
          {quote && (
            <button
              type="button"
              disabled={!selected}
              // Keep the desktop selection alive through the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selected && quote(selected)}
              title={selected ? "Quote the selection into your reply" : "Select text in the plan to quote it"}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 pointer-coarse:px-3 pointer-coarse:py-2"
            >
              <Quote className="size-3" aria-hidden />
              Quote
            </button>
          )}
        </div>
      )}
      <div ref={root} className="min-w-0">
        {diff ? (
          <pre className="max-h-[32rem] overflow-auto rounded-md border bg-background p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {changed === 0 && <span className="text-muted-foreground">No changes.{"\n"}</span>}
            {diff.map((line, i) => (
              <span
                key={i}
                className={cn(
                  "block",
                  line.op === "add" && "bg-success/10 text-success",
                  line.op === "del" && "bg-destructive/10 text-destructive line-through decoration-destructive/40",
                )}
              >
                {line.op === "add" ? "+ " : line.op === "del" ? "- " : "  "}
                {line.text}
              </span>
            ))}
          </pre>
        ) : (
          <div className="max-h-[32rem] overflow-auto text-sm">
            <MessageResponse>{markdown}</MessageResponse>
          </div>
        )}
      </div>
    </div>
  );
}

/** Approve (with an optional note) for an open review. */
export function PlanApprove({
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
  if (done) return <p className="text-xs text-muted-foreground">Approved — the agent starts building.</p>;
  const approve = async () => {
    setBusy(true);
    setError(null);
    const failure = await approvePlanRequest(toolCallId, note.trim() || undefined);
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

/** The transcript's present_plan card. */
export function PlanToolCard({
  toolCallId,
  state,
  output,
  errorText,
}: {
  toolCallId: string;
  state: string;
  output?: unknown;
  errorText?: string;
}) {
  const view = useContext(PlanContext);
  const running = state === "input-streaming" || state === "input-available";
  const failure = output as { ok?: unknown; code?: unknown; message?: unknown } | undefined;
  if (running) {
    return <Card icon={ClipboardList} title="Plan" subtitle="reading PLAN.md…" tone="running" pill="presenting" />;
  }
  if (!isPlanSnapshot(output)) {
    const message = typeof failure?.message === "string" ? failure.message : (errorText ?? "present_plan failed");
    return <Card icon={ClipboardList} title="Plan" subtitle="not shown" tone="fail" pill="failed" failed errorLines={[message]} />;
  }
  const snap = output;
  const latest = view ? view.history.latestId === toolCallId : true;
  const open = view?.history.openReviewId === toolCallId;
  const previous = view?.history.previous.get(toolCallId) ?? null;
  const { done, total } = snap.checklist;
  const pill = open ? "needs you" : snap.status === "review" ? (latest ? "approved" : "superseded") : "progress";
  const tone = open ? "warn" : snap.status === "review" && !latest ? "neutral" : "ok";
  return (
    <Card
      icon={ClipboardList}
      title={`Plan v${snap.version}`}
      subtitle={snap.note ?? (total > 0 ? `${done}/${total} done` : undefined)}
      tone={tone}
      pill={pill}
      extra={total > 0 && snap.note ? <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{done}/{total}</span> : undefined}
      // Older versions collapse to their header; the latest opens.
      defaultOpen={latest}
      className={cn(open && "border-warning/50")}
    >
      <div className="flex flex-col gap-3 p-3">
        <PlanDocument markdown={snap.markdown} previous={previous} quote={view?.quote} />
        {open && (
          <PlanApprove
            toolCallId={toolCallId}
            version={snap.version}
            hint="Or just reply below — the agent revises and presents a new version. Typing never approves."
          />
        )}
      </div>
    </Card>
  );
}

/** The thread header's phase chip (derived from the transcript). */
export function PhaseChip({ phase, className }: { phase: Phase | null; className?: string }) {
  if (!phase) return null;
  const pill = <Pill tone={phase.tone} label={phase.label} />;
  return phase.url ? (
    <a href={phase.url} target="_blank" rel="noreferrer" className={cn("shrink-0", className)} title="Open the PR">
      {pill}
    </a>
  ) : (
    <span className={cn("shrink-0", className)}>{pill}</span>
  );
}
