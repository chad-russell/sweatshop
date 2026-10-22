/**
 * 0064: the outline — one step tree per thread for goal, plan, status and
 * to-dos, replacing 0059's `update_status`. The agent rewrites the whole
 * outline with `update_outline`; the current outline is the last such
 * result in the transcript and the history is all of them. Nothing is
 * stored. No db import (client- and workflow-safe, same rule as
 * lib/status.ts and lib/plan.ts).
 *
 * Legacy compat (0064 decision 10): a transcript's `update_status`
 * results still derive as outlines with no goal, ids slugged from labels,
 * and runner "auto". Shared transcript walkers live in `lib/status.ts`
 * while the legacy mode machinery remains there ahead of its removal.
 */

import type { UIMessage } from "ai";
import {
  STATUS_STATES,
  hasUnresolvedTools,
  isWake,
  isStatusSnapshot,
  partsOf,
  textOf,
  toolNameOf,
  unwrapOutput,
  type StatusSnapshot,
  type StatusState,
  type StatusStep,
} from "./status";
import { harnessRouteSchema, routeLabel, type HarnessRoute } from "./providers/route";

export type OutlineState = StatusState;
export const OUTLINE_STATES = STATUS_STATES;
const STATE_SET: ReadonlySet<string> = new Set(OUTLINE_STATES);

/** Caps (0064 decision 1): an outline is a skimmable tree, not a dump. */
export const OUTLINE_MAX_DEPTH = 4;
export const OUTLINE_MAX_NODES = 200;

export type Runner = "auto" | "self" | "thread" | HarnessRoute;
export type RunnerTool = { kind: "thread" } | { kind: "harness"; route: HarnessRoute };

export interface Step {
  /** Stable agent-chosen slug, kept across rewrites. */
  id: string;
  label: string;
  state: OutlineState;
  detail?: string;
  /** Any depth — capped at OUTLINE_MAX_DEPTH. */
  children?: Step[];
  /** Top-level steps only — the unit of delegation. Default "auto". */
  runner?: Runner;
}

export interface Outline {
  /** The one-line summary. */
  goal: string;
  steps: Step[];
  note?: string;
}

export type RunnerGate =
  | { ok: true; active: Step | null; route: HarnessRoute | null }
  | { ok: false; active: Step; message: string };

function sameRoute(a: HarnessRoute, b: HarnessRoute): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Pure runner decision. Callers perform route availability/restriction
 * checks after this gate and before claiming a slot or creating a child. */
export function runnerGate(outline: Outline | null | undefined, tool: RunnerTool): RunnerGate {
  const active = outline?.steps.find((step) => step.state === "active") ?? null;
  if (!active || active.runner === undefined || active.runner === "auto") {
    return { ok: true, active, route: null };
  }
  const change = "call update_outline to change the active step's runner";
  if (active.runner === "self") {
    return { ok: false, active, message: `active step "${active.label}" is assigned to self; delegation is refused — ${change}` };
  }
  if (active.runner === "thread") {
    return tool.kind === "thread"
      ? { ok: true, active, route: null }
      : { ok: false, active, message: `active step "${active.label}" is assigned to thread; harness calls are refused — ${change}` };
  }
  if (tool.kind === "thread") {
    return {
      ok: false,
      active,
      message: `active step "${active.label}" is pinned to ${runnerLabel(active.runner)}; start_thread is refused — ${change}`,
    };
  }
  if (!sameRoute(active.runner, tool.route)) {
    return {
      ok: false,
      active,
      message: `active step "${active.label}" is pinned to ${runnerLabel(active.runner)}; a different harness route is refused — ${change}`,
    };
  }
  return { ok: true, active, route: active.runner };
}

function handoffStep(step: Step, depth: number): string[] {
  const indent = "  ".repeat(depth);
  const detail = step.detail ? ` — ${step.detail}` : "";
  const lines = [`${indent}- ${step.label} [${step.state}]${detail}`];
  for (const child of step.children ?? []) lines.push(...handoffStep(child, depth + 1));
  return lines;
}

export const OUTLINE_HANDOFF_START = "[outline context]";
export const OUTLINE_HANDOFF_END = "[/outline context]";

/** Compact worker context for the active top-level step. */
export function renderOutlineHandoff(outline: Outline, step: Step): string {
  return [OUTLINE_HANDOFF_START, `Goal: ${outline.goal}`, ...handoffStep(step, 0), OUTLINE_HANDOFF_END].join("\n");
}

export function prependOutlineHandoff(task: string, outline: Outline | null | undefined): { task: string; step: string | null } {
  const active = outline?.steps.find((step) => step.state === "active") ?? null;
  if (!outline || !active) return { task, step: null };
  return { task: `${renderOutlineHandoff(outline, active)}\n\n${task}`, step: active.label };
}

/** After approval the owner may only change runners on pending top-level
 * steps. Labels, order, state, details, children, goal, and note freeze. */
export function isPendingRunnerEdit(before: Outline, after: Outline): boolean {
  if (before.goal !== after.goal || before.note !== after.note || before.steps.length !== after.steps.length) return false;
  return before.steps.every((step, index) => {
    const next = after.steps[index];
    if (!next) return false;
    const { runner: beforeRunner, ...beforeRest } = step;
    const { runner: afterRunner, ...afterRest } = next;
    if (JSON.stringify(beforeRest) !== JSON.stringify(afterRest)) return false;
    return beforeRunner === afterRunner || step.state === "pending";
  });
}

function isRunnerValue(value: unknown): value is Runner {
  if (value === "auto" || value === "self" || value === "thread") return true;
  return harnessRouteSchema.safeParse(value).success;
}

// --- shape guards (lenient — caps are a write-time concern; a historical
// snapshot that predates a cap change must still render) ------------------

function isStepShape(value: unknown, depth: number): value is Step {
  if (!value || typeof value !== "object") return false;
  const step = value as Partial<Step>;
  if (typeof step.id !== "string" || step.id.trim() === "") return false;
  if (typeof step.label !== "string" || step.label.trim() === "") return false;
  if (typeof step.state !== "string" || !STATE_SET.has(step.state)) return false;
  if (step.detail !== undefined && typeof step.detail !== "string") return false;
  if (step.runner !== undefined && (depth > 0 || !isRunnerValue(step.runner))) return false;
  if (step.children === undefined) return true;
  if (!Array.isArray(step.children)) return false;
  return step.children.every((child) => isStepShape(child, depth + 1));
}

export function isOutline(value: unknown): value is Outline {
  if (!value || typeof value !== "object") return false;
  const outline = value as Partial<Outline>;
  if (typeof outline.goal !== "string") return false;
  if (!Array.isArray(outline.steps) || outline.steps.length === 0) return false;
  if (!outline.steps.every((step) => isStepShape(step, 0))) return false;
  if (outline.note !== undefined && typeof outline.note !== "string") return false;
  return true;
}

// --- validation (write time: update_outline's core) -----------------------

export type OutlineFail = { ok: false; code: "invalid"; message: string };
const fail = (message: string): OutlineFail => ({ ok: false, code: "invalid", message });

type StepParse = { step: Step; count: number } | string;

function parseStep(value: unknown, depth: number, ids: Set<string>, topLevel: boolean): StepParse {
  if (!value || typeof value !== "object") return "each step needs an id, a label, and a state";
  const raw = value as { id?: unknown; label?: unknown; state?: unknown; detail?: unknown; children?: unknown; runner?: unknown };
  if (typeof raw.id !== "string" || raw.id.trim() === "") return "each step needs a non-empty id";
  const id = raw.id.trim();
  if (ids.has(id)) return `duplicate step id "${id}"`;
  ids.add(id);
  if (typeof raw.label !== "string" || raw.label.trim() === "") return `step "${id}" needs a label`;
  if (typeof raw.state !== "string" || !STATE_SET.has(raw.state)) {
    return `step "${id}" needs a state (pending, active, done, skipped, blocked)`;
  }
  if (raw.detail !== undefined && typeof raw.detail !== "string") return `step "${id}"'s detail must be text`;
  if (raw.runner !== undefined && !topLevel) return `step "${id}": runner only applies to top-level steps`;
  if (raw.runner !== undefined && !isRunnerValue(raw.runner)) return `step "${id}": invalid runner`;
  const step: Step = { id, label: raw.label.trim(), state: raw.state as OutlineState };
  if (typeof raw.detail === "string" && raw.detail.trim()) step.detail = raw.detail.trim();
  if (raw.runner !== undefined) step.runner = raw.runner as Runner;
  let count = 1;
  if (raw.children !== undefined) {
    if (!Array.isArray(raw.children)) return `step "${id}"'s children must be a list`;
    if (raw.children.length > 0 && depth + 1 >= OUTLINE_MAX_DEPTH) {
      return `step "${id}": outline is nested too deep (max depth ${OUTLINE_MAX_DEPTH})`;
    }
    const children: Step[] = [];
    for (const child of raw.children) {
      const parsed = parseStep(child, depth + 1, ids, false);
      if (typeof parsed === "string") return parsed;
      children.push(parsed.step);
      count += parsed.count;
    }
    if (children.length > 0) step.children = children;
  }
  return { step, count };
}

/** Validate and normalize a whole-outline rewrite. */
export function validateOutline(input: unknown): Outline | OutlineFail {
  if (!input || typeof input !== "object") return fail("outline needs a goal and steps");
  const raw = input as { goal?: unknown; steps?: unknown; note?: unknown };
  if (typeof raw.goal !== "string" || raw.goal.trim() === "") return fail("outline needs a one-line goal");
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return fail("outline needs at least one step");
  const ids = new Set<string>();
  const steps: Step[] = [];
  let total = 0;
  for (const item of raw.steps) {
    const parsed = parseStep(item, 0, ids, true);
    if (typeof parsed === "string") return fail(parsed);
    steps.push(parsed.step);
    total += parsed.count;
  }
  if (total > OUTLINE_MAX_NODES) return fail(`at most ${OUTLINE_MAX_NODES} steps total`);
  if (raw.note !== undefined && typeof raw.note !== "string") return fail("note must be text");
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  const goal = raw.goal.trim();
  return note ? { goal, steps, note } : { goal, steps };
}

// --- legacy compat: `update_status` snapshots read as outlines ------------

function slugify(label: string): string {
  const base = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "step";
}

function uniqueSlug(label: string, used: Set<string>): string {
  const base = slugify(label);
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function legacyStep(step: StatusStep, depth: number, used: Set<string>): Step {
  const out: Step = { id: uniqueSlug(step.label, used), label: step.label, state: step.state };
  if (step.detail) out.detail = step.detail;
  if (step.children?.length) out.children = step.children.map((child) => legacyStep(child, depth + 1, used));
  if (depth === 0) out.runner = "auto";
  return out;
}

/** A `StatusSnapshot` read as an outline: no goal, ids slugged from
 *  labels (unique within the tree), runner "auto" on every top-level step. */
export function legacyOutlineFromStatus(status: StatusSnapshot): Outline {
  const used = new Set<string>();
  const steps = status.steps.map((step) => legacyStep(step, 0, used));
  return status.note ? { goal: "", steps, note: status.note } : { goal: "", steps };
}

// --- derivation (read time) ------------------------------------------------

export interface OutlineSnapshot {
  ok: true;
  version: number;
  outline: Outline;
  /** This call opened a review (`propose: true`). */
  proposed: boolean;
  next: string;
}

export interface OutlineEditSnapshot {
  version: number;
  outline: Outline;
  proposed: boolean;
}

export const OUTLINE_EDIT_PREFIX = "[outline edited by owner] ";

/** Model-visible form of an owner edit. Metadata renders the transcript
 * chip; this compact payload makes the snapshot derivable from history. */
export function renderOutlineEdit(snapshot: OutlineEditSnapshot): string {
  return `${OUTLINE_EDIT_PREFIX}${JSON.stringify(snapshot)}`;
}

export function parseOutlineEdit(message: unknown): OutlineEditSnapshot | null {
  if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") return null;
  const text = textOf(message).trim();
  if (!text.startsWith(OUTLINE_EDIT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(OUTLINE_EDIT_PREFIX.length)) as Partial<OutlineEditSnapshot>;
    return typeof parsed.version === "number" && typeof parsed.proposed === "boolean" && isOutline(parsed.outline)
      ? { version: parsed.version, proposed: parsed.proposed, outline: parsed.outline }
      : null;
  } catch {
    return null;
  }
}

export function isOutlineSnapshot(value: unknown): value is OutlineSnapshot {
  const v = value as Partial<OutlineSnapshot> | null | undefined;
  return !!v && v.ok === true && typeof v.version === "number" && typeof v.proposed === "boolean" && isOutline(v.outline);
}

/** What a review row's card (and accept_outline's approval card) carries. */
export interface OutlineCard {
  kind: "outline";
  version: number;
  outline: Outline;
  note?: string;
}

export function isOutlineCard(value: unknown): value is OutlineCard {
  const v = value as Partial<OutlineCard> | null | undefined;
  return !!v && v.kind === "outline" && typeof v.version === "number" && isOutline(v.outline);
}

/** One landed rewrite in the transcript. */
export interface OutlineEntry {
  version: number;
  outline: Outline;
  proposed: boolean;
}

export interface DerivedOutline {
  current: OutlineEntry | null;
  history: OutlineEntry[];
  /** A wake followed by a completed assistant turn that did not call
   *  update_outline. */
  stale: boolean;
  /** The latest proposed entry not yet approved — null when nothing is
   *  in review. */
  review: OutlineEntry | null;
}

const OUTLINE_APPROVAL_TEXT = /^\[outline v\d+ approved\]/;

function toolOutput(part: unknown): unknown {
  const record = part as { output?: unknown; result?: unknown };
  return unwrapOutput(record.output ?? record.result);
}

interface RawEntry {
  outline: Outline;
  proposed: boolean;
  /** Set for a live `update_outline` result (the version it recorded at
   *  write time); undefined for a legacy `update_status` result, whose
   *  version the caller counts from its position instead. */
  version?: number;
}

/** `update_outline` and legacy `update_status` results in one message, in order. */
function entriesFromMessage(message: unknown): RawEntry[] {
  const out: RawEntry[] = [];
  const edit = parseOutlineEdit(message);
  if (edit) out.push(edit);
  for (const part of partsOf(message)) {
    const name = toolNameOf(part);
    if (name !== "update_outline" && name !== "update_status") continue;
    const state = (part as { state?: unknown }).state;
    if (typeof state === "string" && state !== "output-available") continue;
    const output = toolOutput(part);
    if (name === "update_outline" && isOutlineSnapshot(output)) {
      out.push({ outline: output.outline, proposed: output.proposed, version: output.version });
    } else if (name === "update_status" && isStatusSnapshot(output)) {
      out.push({ outline: legacyOutlineFromStatus(output), proposed: false });
    }
  }
  return out;
}

function isOutlineApproval(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  if ((message as { role?: unknown }).role === "user") {
    const runEvent = (message as { metadata?: { runEvent?: { kind?: unknown; status?: unknown } } }).metadata?.runEvent;
    if (runEvent?.kind === "outline" && runEvent.status === "approved") return true;
    return OUTLINE_APPROVAL_TEXT.test(textOf(message).trim());
  }
  for (const part of partsOf(message)) {
    if (toolNameOf(part) !== "accept_outline") continue;
    const output = toolOutput(part);
    if ((output as { approved?: unknown } | null)?.approved === true) return true;
  }
  return false;
}

/** The stale bit — mirrors `lib/status.ts`'s `deriveStatus` buffering:
 *  a wake not followed (before the turn ends) by any rewrite is stale. */
function computeStale(messages: readonly unknown[]): boolean {
  let stale = false;
  let haveCurrent = false;
  let buffer: unknown[] = [];
  let bufferWake = false;

  const flush = (ended: boolean) => {
    const got = buffer.reduce<number>((n, m) => n + entriesFromMessage(m).length, 0);
    if (got > 0) haveCurrent = true;
    if (bufferWake) {
      if (got > 0) {
        stale = false;
      } else {
        const assistants = buffer.filter((m) => (m as { role?: unknown }).role === "assistant");
        if (assistants.length > 0) {
          const unresolved = hasUnresolvedTools(assistants[assistants.length - 1]);
          if ((ended || !unresolved) && haveCurrent) stale = true;
        }
      }
    } else if (got > 0) {
      stale = false;
    }
    buffer = [];
    bufferWake = false;
  };

  for (const message of messages) {
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "user") {
      flush(true);
      bufferWake = isWake(message);
      continue;
    }
    buffer.push(message);
  }
  flush(false);
  return stale;
}

/**
 * Current outline, every prior rewrite, the stale bit, and the open
 * review (if any). Accepts UI messages (`parts`) and model messages
 * (`content`) so the chip, the per-turn note, and wakes share one walk.
 */
export function deriveOutline(messages: readonly unknown[]): DerivedOutline {
  const history: OutlineEntry[] = [];
  let current: OutlineEntry | null = null;
  let review: OutlineEntry | null = null;
  let version = 0;

  for (const message of messages) {
    for (const raw of entriesFromMessage(message)) {
      version = raw.version ?? version + 1;
      const entry: OutlineEntry = { version, outline: raw.outline, proposed: raw.proposed };
      history.push(entry);
      current = entry;
      if (raw.proposed) review = entry;
    }
    if (isOutlineApproval(message)) review = null;
  }

  return { current, history, stale: computeStale(messages), review };
}

// --- chip + note ------------------------------------------------------------

export interface OutlineChip {
  label: string;
  tone: "warn" | "running" | "ok";
}

/** The first top-level step in `state`, else the first matching
 *  immediate child (one level, same restriction as lib/status.ts). */
function findOutlineStep(steps: readonly Step[], state: OutlineState): Step | null {
  const top = steps.find((step) => step.state === state);
  if (top) return top;
  for (const step of steps) {
    const child = step.children?.find((item) => item.state === state);
    if (child) return child;
  }
  return null;
}

export function progressCount(steps: readonly Step[]): { done: number; total: number } {
  return { done: steps.filter((step) => step.state === "done").length, total: steps.length };
}

/** Header-chip text for one outline (ignoring any open review). */
export function outlineChipLabel(outline: Outline): OutlineChip | null {
  const steps = outline.steps;
  if (steps.length === 0) return null;
  const blocked = findOutlineStep(steps, "blocked");
  if (blocked) return { label: `${blocked.label} · needs you`, tone: "warn" };
  const active = steps.find((step) => step.state === "active");
  if (active) {
    const basis = active.children && active.children.length > 0 ? active.children : steps;
    const { done, total } = progressCount(basis);
    return { label: total > 0 ? `${active.label} · ${done}/${total}` : active.label, tone: "running" };
  }
  const { done, total } = progressCount(steps);
  const doneStep = [...steps].reverse().find((step) => step.state === "done");
  const named = doneStep ?? steps.find((step) => step.state === "pending") ?? steps[0]!;
  return { label: total > 0 ? `${named.label} · ${done}/${total}` : named.label, tone: "ok" };
}

/** The header chip from a derived outline: a blocked step wins, then an
 *  open review ("needs you"), else the plain chip. */
export function outlineChip(derived: DerivedOutline): OutlineChip | null {
  if (!derived.current) return null;
  const chip = outlineChipLabel(derived.current.outline);
  if (chip?.tone === "warn") return chip;
  if (derived.review) return { label: `Outline v${derived.review.version} · needs you`, tone: "warn" };
  return chip;
}

/** The active top-level step's label, for wakes. */
export function activeStepLabel(derived: DerivedOutline): string | null {
  const active = derived.current?.outline.steps.find((step) => step.state === "active");
  return active?.label ?? null;
}

/** Display text for a runner badge or the thread-state note — "auto" by
 *  default, "self"/"thread" verbatim, else the pinned harness route. */
export function runnerLabel(runner: Runner | undefined): string {
  if (runner === undefined || runner === "auto") return "auto";
  if (runner === "self" || runner === "thread") return runner;
  return routeLabel(runner);
}

function openChildrenText(step: Step): string {
  const open = (step.children ?? []).filter((child) => child.state !== "done" && child.state !== "skipped");
  if (open.length === 0) return "";
  return ` — open: ${open.map((child) => `${child.label} (${child.state})`).join(", ")}`;
}

function nextTopStep(steps: readonly Step[], active: Step | null): Step | null {
  const from = active ? steps.indexOf(active) + 1 : 0;
  for (let i = from; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.state !== "done" && step.state !== "skipped") return step;
  }
  return null;
}

export const THREAD_STATE_PREFIX = "[thread state]";

/**
 * The per-turn `[thread state]` note. The rendered string is stored on
 * the user row and replayed verbatim (`metadata.threadState`). Null when
 * there is nothing to say — a plain chat that has never called
 * `update_outline`. A mode with declared phases and no outline yet still
 * gets a seed line so the agent knows which steps to write.
 */
export function renderThreadStateNote(
  derived: DerivedOutline,
  seedPhases?: readonly { name: string }[] | null,
): string | null {
  if (derived.current) {
    const { goal, steps, note } = derived.current.outline;
    const chip = outlineChip(derived);
    const head = `${chip?.label ?? "outline"}${derived.stale ? " (stale)" : ""}`;
    const active = steps.find((step) => step.state === "active") ?? null;
    const next = nextTopStep(steps, active);
    const parts = [`${THREAD_STATE_PREFIX} ${head}`, `goal: ${goal || "(none)"}`];
    if (active) parts.push(`active: ${active.label} (${runnerLabel(active.runner)})${openChildrenText(active)}`);
    if (next) parts.push(`next: ${next.label} (${runnerLabel(next.runner)})`);
    if (note) parts.push(`note: ${note}`);
    parts.push("if this changed, call update_outline");
    return parts.join(" — ");
  }
  if (seedPhases && seedPhases.length > 0) {
    const names = seedPhases.map((phase) => phase.name).join(" → ");
    return `${THREAD_STATE_PREFIX} no outline yet — seed update_outline from: ${names} — if this changed, call update_outline`;
  }
  return null;
}

// --- diff (PR1 UI: "changes since vN") -------------------------------------

export type OutlineStepDiffKind = "added" | "removed" | "state-changed";

export interface OutlineStepDiff {
  id: string;
  label: string;
  kind: OutlineStepDiffKind;
  fromState?: OutlineState;
  toState?: OutlineState;
}

function flattenSteps(steps: readonly Step[]): Map<string, Step> {
  const out = new Map<string, Step>();
  const walk = (list: readonly Step[]) => {
    for (const step of list) {
      out.set(step.id, step);
      if (step.children) walk(step.children);
    }
  };
  walk(steps);
  return out;
}

/** Simple added/removed/state-changed markers by step id — not a full
 *  tree diff (0064 decision: "simple ... markers"). */
export function diffOutlineSteps(before: Outline, after: Outline): OutlineStepDiff[] {
  const prev = flattenSteps(before.steps);
  const next = flattenSteps(after.steps);
  const out: OutlineStepDiff[] = [];
  for (const [id, step] of next) {
    const was = prev.get(id);
    if (!was) out.push({ id, label: step.label, kind: "added", toState: step.state });
    else if (was.state !== step.state) out.push({ id, label: step.label, kind: "state-changed", fromState: was.state, toState: step.state });
  }
  for (const [id, step] of prev) {
    if (!next.has(id)) out.push({ id, label: step.label, kind: "removed", fromState: step.state });
  }
  return out;
}

// --- UI transcript history (card: "changes since vN", open-review hint) ---

type LoosePart = { type: string; state?: string; output?: unknown; toolCallId?: string; text?: string };

function isApprovalMessage(message: UIMessage): boolean {
  if (message.role !== "user") return false;
  const runEvent = (message.metadata as { runEvent?: { kind?: string; status?: string } } | undefined)?.runEvent;
  if (runEvent?.kind === "outline" && runEvent.status === "approved") return true;
  return message.parts.some((p) => p.type === "text" && OUTLINE_APPROVAL_TEXT.test((p as LoosePart).text ?? ""));
}

/** Per update_outline (or legacy update_status) call in a transcript: the
 *  previous snapshot's outline (for "changes since"), the latest call,
 *  and the open review (if the latest proposed version is unapproved). */
export interface OutlineTranscriptHistory {
  previous: Map<string, { version: number; outline: Outline }>;
  latestId: string | null;
  openReviewId: string | null;
}

export function outlineHistory(messages: readonly UIMessage[]): OutlineTranscriptHistory {
  const previous = new Map<string, { version: number; outline: Outline }>();
  let last: { id: string; version: number; outline: Outline; proposed: boolean } | null = null;
  let approvedAfterLast = false;
  for (const message of messages) {
    if (isApprovalMessage(message)) approvedAfterLast = true;
    const edit = parseOutlineEdit(message);
    if (edit) {
      const id = message.id;
      if (last) previous.set(id, { version: last.version, outline: last.outline });
      last = { id, version: edit.version, outline: edit.outline, proposed: edit.proposed };
      approvedAfterLast = !edit.proposed;
    }
    for (const raw of message.parts) {
      const part = raw as LoosePart;
      if (part.type === "tool-accept_outline" && part.state === "output-available") {
        if ((part.output as { approved?: unknown } | undefined)?.approved === true) approvedAfterLast = true;
      }
      let entry: { outline: Outline; proposed: boolean; version: number } | null = null;
      const priorVersion: number = last === null ? 0 : last.version;
      if (part.type === "tool-update_outline" && part.state === "output-available" && isOutlineSnapshot(part.output)) {
        entry = { outline: part.output.outline, proposed: part.output.proposed, version: part.output.version };
      } else if (part.type === "tool-update_status" && part.state === "output-available" && isStatusSnapshot(part.output)) {
        entry = { outline: legacyOutlineFromStatus(part.output), proposed: false, version: priorVersion + 1 };
      }
      if (!entry) continue;
      const id = part.toolCallId ?? "";
      if (last) previous.set(id, { version: last.version, outline: last.outline });
      last = { id, version: entry.version, outline: entry.outline, proposed: entry.proposed };
      if (entry.proposed) approvedAfterLast = false;
    }
  }
  return {
    previous,
    latestId: last?.id ?? null,
    openReviewId: last && last.proposed && !approvedAfterLast ? last.id : null,
  };
}
