"use client";

import { ArrowDown, ArrowUp, Ban, Check, ChevronRight, Circle, CircleDot, Minus, Pencil, Plus, Quote, Trash2 } from "lucide-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Card } from "@/components/ai-elements/agent-cards";
import { HarnessRoutePicker } from "@/components/harness-route-picker";
import { useModelsView } from "@/components/route-picker";
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

type PresentStepDiff = OutlineStepDiff & { kind: "added" | "state-changed" };

function diffFor(id: string, diff: readonly OutlineStepDiff[] | null): PresentStepDiff | undefined {
  return diff?.find((entry): entry is PresentStepDiff => entry.id === id && entry.kind !== "removed");
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
                mine.kind === "state-changed" && "text-info",
              )}
            >
              {mine.kind === "added" ? <Plus className="inline size-3" aria-hidden /> : `${mine.fromState} → ${mine.toState}`}
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
  const removed = diff?.filter((entry) => entry.kind === "removed") ?? [];

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
      {showDiff && previous && removed.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <p className="font-medium">Removed since v{previous.version}</p>
          <ul className="mt-1 list-disc pl-5">
            {removed.map((entry) => (
              <li key={entry.id} className="line-through">
                {entry.label}
              </li>
            ))}
          </ul>
        </div>
      )}
      {outline.note && <p className="text-xs text-muted-foreground">{outline.note}</p>}
    </div>
  );
}

function stepCount(steps: readonly Step[]): number {
  return steps.reduce((total, step) => total + 1 + stepCount(step.children ?? []), 0);
}

function uniqueStepId(label: string, outline: Outline): string {
  const used = new Set<string>();
  const collect = (steps: readonly Step[]) => steps.forEach((step) => {
    used.add(step.id);
    collect(step.children ?? []);
  });
  collect(outline.steps);
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "step";
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

function updateAt(steps: readonly Step[], path: readonly number[], update: (step: Step) => Step): Step[] {
  const [index, ...rest] = path;
  if (index === undefined) return [...steps];
  return steps.map((step, i) => i !== index ? step : rest.length === 0
    ? update(step)
    : { ...step, children: updateAt(step.children ?? [], rest, update) });
}

function siblingsAt(outline: Outline, parent: readonly number[]): Step[] {
  let steps = outline.steps;
  for (const index of parent) steps = steps[index]?.children ?? [];
  return steps;
}

function replaceSiblings(outline: Outline, parent: readonly number[], steps: Step[]): Outline {
  if (parent.length === 0) return { ...outline, steps };
  return { ...outline, steps: updateAt(outline.steps, parent, (step) => ({ ...step, children: steps })) };
}

interface EditOutlineResponse {
  version: number;
  rowId: string;
  approved: boolean;
}

async function editOutlineRequest(input: {
  conversationId: string;
  outline: Outline;
  baseVersion: number;
  approve?: boolean;
  note?: string;
}): Promise<{ failure: string | null; saved: EditOutlineResponse | null }> {
  try {
    const res = await fetch("/api/x/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: input.conversationId,
        editOutline: input.outline,
        baseVersion: input.baseVersion,
        ...(input.approve ? { approve: true } : {}),
        ...(input.note ? { note: input.note } : {}),
      }),
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.ok) return { failure: null, saved: body as EditOutlineResponse | null };
    return { failure: body?.error ?? `save failed (${res.status})`, saved: null };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error), saved: null };
  }
}

function OutlineEditor({ initial, version, conversationId, projectId, review, onSaved }: {
  initial: Outline;
  version: number;
  conversationId: string;
  projectId: string | null;
  review: boolean;
  onSaved: (outline: Outline, saved: EditOutlineResponse) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const models = useModelsView(projectId);
  const save = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    const { failure, saved } = await editOutlineRequest({ conversationId, outline: draft, baseVersion: version, approve, note: note.trim() || undefined });
    setBusy(false);
    if (failure || !saved) setError(failure ?? "save failed");
    else onSaved(draft, saved);
  };
  const changeStep = (path: number[], update: (step: Step) => Step) => setDraft((value) => ({ ...value, steps: updateAt(value.steps, path, update) }));
  const remove = (path: number[]) => setDraft((value) => {
    const parent = path.slice(0, -1);
    const index = path[path.length - 1]!;
    return replaceSiblings(value, parent, siblingsAt(value, parent).filter((_, i) => i !== index));
  });
  const move = (path: number[], by: -1 | 1) => setDraft((value) => {
    const parent = path.slice(0, -1);
    const index = path[path.length - 1]!;
    const siblings = [...siblingsAt(value, parent)];
    const target = index + by;
    if (target < 0 || target >= siblings.length) return value;
    [siblings[index], siblings[target]] = [siblings[target]!, siblings[index]!];
    return replaceSiblings(value, parent, siblings);
  });
  const add = (parent: number[]) => setDraft((value) => {
    if (stepCount(value.steps) >= 200) return value;
    const siblings = siblingsAt(value, parent);
    const step: Step = { id: uniqueStepId("New step", value), label: "New step", state: "pending" };
    return replaceSiblings(value, parent, [...siblings, step]);
  });

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-2">
      {review && (
        <input aria-label="Outline goal" className="h-8 rounded-md border border-border bg-background px-2 text-sm" value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} />
      )}
      <ul className="flex flex-col gap-1">
        {draft.steps.map((step, index) => (
          <EditableStep key={step.id} step={step} path={[index]} depth={1} review={review} models={models} onChange={changeStep} onRemove={remove} onMove={move} onAdd={add} />
        ))}
      </ul>
      {review && stepCount(draft.steps) < 200 && (
        <button type="button" className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground" onClick={() => add([])}>
          <Plus className="size-3" /> Add step
        </button>
      )}
      {review && <input aria-label="Approval note" className="h-8 rounded-md border border-border bg-background px-2 text-sm" placeholder="Optional note" value={note} onChange={(event) => setNote(event.target.value)} />}
      <div className="flex gap-2">
        <button type="button" disabled={busy} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium disabled:opacity-50" onClick={() => void save(false)}>Save</button>
        {review && <button type="button" disabled={busy} className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50" onClick={() => void save(true)}>Save &amp; approve</button>}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function EditableStep({ step, path, depth, review, models, onChange, onRemove, onMove, onAdd }: {
  step: Step;
  path: number[];
  depth: number;
  review: boolean;
  models: ReturnType<typeof useModelsView>;
  onChange: (path: number[], update: (step: Step) => Step) => void;
  onRemove: (path: number[]) => void;
  onMove: (path: number[], by: -1 | 1) => void;
  onAdd: (parent: number[]) => void;
}) {
  const top = depth === 1;
  return (
    <li className={cn("flex flex-col gap-1", depth > 1 && "ml-5 border-l border-border pl-2")}>
      <div className="flex flex-wrap items-center gap-1">
        {review ? (
          <input aria-label={`Step label ${step.id}`} className="h-7 min-w-28 flex-1 rounded-md border border-border bg-background px-2 text-sm" value={step.label} onChange={(event) => onChange(path, (value) => ({ ...value, label: event.target.value }))} />
        ) : <span className="min-w-28 flex-1 text-sm">{step.label}</span>}
        {top && (review || step.state === "pending") && (
          <HarnessRoutePicker value={step.runner} view={models} onChange={(runner) => onChange(path, (value) => ({ ...value, runner }))} />
        )}
        {review && (
          <>
            <button type="button" aria-label="Move step up" className="text-muted-foreground hover:text-foreground" onClick={() => onMove(path, -1)}><ArrowUp className="size-3.5" /></button>
            <button type="button" aria-label="Move step down" className="text-muted-foreground hover:text-foreground" onClick={() => onMove(path, 1)}><ArrowDown className="size-3.5" /></button>
            <button type="button" aria-label="Delete step" className="text-muted-foreground hover:text-destructive" onClick={() => onRemove(path)}><Trash2 className="size-3.5" /></button>
            {depth < 4 && <button type="button" aria-label="Add child step" className="text-muted-foreground hover:text-foreground" onClick={() => onAdd(path)}><Plus className="size-3.5" /></button>}
          </>
        )}
      </div>
      {(step.children ?? []).map((child, index) => (
        <EditableStep key={child.id} step={child} path={[...path, index]} depth={depth + 1} review={review} models={models} onChange={onChange} onRemove={onRemove} onMove={onMove} onAdd={onAdd} />
      ))}
    </li>
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
  conversationId: string;
  projectId: string | null;
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
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<{ outline: Outline; version: number; reviewId: string; approved: boolean } | null>(null);
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
  const anchored = view ? view.history.cardAnchorId === toolCallId : true;
  const current = anchored ? view?.history.current : null;
  if (current) {
    outline = current.outline;
    version = current.version;
    proposed = current.proposed;
  }
  // An owner edit in this session replaced the stream's snapshot: the
  // card shows the edited tree, the new version, and (until approved)
  // the new review row.
  const savedActive = saved !== null && saved.version >= (version ?? 0);
  if (savedActive) {
    outline = saved.outline;
    version = saved.version;
    proposed = !saved.approved;
  }
  const latest = anchored;
  const open = Boolean(anchored && view && (savedActive ? !saved!.approved : view.history.openReviewId));
  const previous = view?.history.previous.get(toolCallId) ?? null;
  const reviewId = savedActive ? saved!.reviewId : (view?.history.openReviewId ?? toolCallId);
  const pill = open ? "needs you" : proposed ? (latest ? "approved" : "superseded") : "recorded";
  const tone = open ? "warn" : proposed && !latest ? "neutral" : "ok";
  const shown = savedActive ? saved!.outline : outline;
  const canEditReview = Boolean(open && view && version);
  const canEditApprovedRunners = Boolean(latest && view?.history.approved && shown.steps.some((step) => step.state === "pending"));
  return (
    <Card
      icon={Check}
      title={version ? `Outline v${version}` : "Outline"}
      subtitle={shown.goal || undefined}
      tone={tone}
      pill={pill}
      defaultOpen={latest}
      className={cn(open && "border-warning/50")}
    >
      <div className="flex flex-col gap-3 p-3">
        <OutlineDocument outline={shown} previous={previous} quote={view?.quote} />
        {(canEditReview || canEditApprovedRunners) && !editing && !saved && (
          <button type="button" className="inline-flex items-center gap-1 self-start rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => setEditing(true)}>
            <Pencil className="size-3" aria-hidden /> {canEditReview ? "Edit outline" : "Edit pending runners"}
          </button>
        )}
        {editing && view && version && (
          <OutlineEditor
            initial={shown}
            version={version}
            conversationId={view.conversationId}
            projectId={view.projectId}
            review={canEditReview}
            onSaved={(next, savedResponse) => {
              setSaved({ outline: next, version: savedResponse.version, reviewId: savedResponse.rowId, approved: savedResponse.approved });
              setEditing(false);
            }}
          />
        )}
        {saved && <p className="text-xs text-muted-foreground">{saved.approved ? `Saved and approved as v${saved.version}.` : `Saved as v${saved.version}.`}</p>}
        {open && !editing && (
          <OutlineApprove
            toolCallId={reviewId}
            version={version ?? 0}
            hint="Or just reply below — the agent revises and updates again. Typing never approves."
          />
        )}
      </div>
    </Card>
  );
}
