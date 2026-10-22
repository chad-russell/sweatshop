import type { UIMessage } from "ai";
import { deriveOutline, outlineChip, type DerivedOutline } from "./outline";

/**
 * 0041: plan files — the pure half. The plan is a scratch PLAN.md in the
 * conversation's work root; `present_plan` snapshots it into a tool
 * result. Everything here derives from those snapshots and the
 * transcript: the checklist count, a line diff between versions, and
 * the thread's phase chip. Nothing is stored; nothing here touches the
 * sandbox or sqlite (client- and server-safe).
 */

/** The plan file's name, beside the repo checkouts in the work root. */
export const PLAN_FILE = "PLAN.md";

/** Snapshot cap — plans are short documents, not dumps. */
export const PLAN_MAX_BYTES = 64 * 1024;

export interface Checklist {
  done: number;
  total: number;
}

const CHECKBOX = /^\s*[-*+]\s+\[( |x|X)\]\s/;

/** Count markdown task-list items (`- [ ]` / `- [x]`). */
export function parseChecklist(markdown: string): Checklist {
  let done = 0;
  let total = 0;
  for (const line of markdown.split("\n")) {
    const m = CHECKBOX.exec(line);
    if (!m) continue;
    total += 1;
    if (m[1] !== " ") done += 1;
  }
  return { done, total };
}

/** What a plan review row's card (and accept_plan's approval card) carries. */
export interface PlanCard {
  kind: "plan";
  version: number;
  markdown: string;
  checklist: Checklist;
  note?: string;
}

export function isPlanCard(value: unknown): value is PlanCard {
  const v = value as Partial<PlanCard> | null | undefined;
  return !!v && v.kind === "plan" && typeof v.version === "number" && typeof v.markdown === "string";
}

/** What present_plan returns (the snapshot) — rendered as the plan card. */
export interface PlanSnapshot {
  ok: true;
  version: number;
  markdown: string;
  checklist: Checklist;
  /** review = waiting on Chad's approval; progress = an approved plan's update. */
  status: "review" | "progress";
  note?: string;
  /** For the model: what happens next. */
  next: string;
}

export function isPlanSnapshot(value: unknown): value is PlanSnapshot {
  const v = value as Partial<PlanSnapshot> | null | undefined;
  return !!v && v.ok === true && typeof v.version === "number" && typeof v.markdown === "string";
}

// --- diff ---------------------------------------------------------------------

export interface DiffLine {
  op: "same" | "add" | "del";
  text: string;
}

/** Above this many LCS cells the diff degrades to "all removed, all added". */
const DIFF_CELL_CAP = 4_000_000;

/** Line diff by longest common subsequence (plans are small). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > DIFF_CELL_CAP) {
    return [...a.map((text) => ({ op: "del" as const, text })), ...b.map((text) => ({ op: "add" as const, text }))];
  }
  // lcs[i][j] = LCS length of a[i:] and b[j:], one flat row-major array.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      out.push({ op: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ op: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < n) out.push({ op: "del", text: a[i++] });
  while (j < m) out.push({ op: "add", text: b[j++] });
  return out;
}

// --- phase --------------------------------------------------------------------

/** The transcript facts the phase derives from, in order. */
export type PhaseEvent =
  | { type: "plan"; version: number; status: "review" | "progress"; checklist: Checklist }
  | { type: "plan-approved" }
  | { type: "pr-pending" }
  | { type: "pr-open"; url?: string }
  | { type: "pr-not-opened" };

export interface Phase {
  label: string;
  tone: "warn" | "running" | "ok";
  url?: string;
  /** 0052: "pr-open" marks the one phase a live host check may relabel. */
  kind?: "pr-open";
  /** 0059: a wake landed and the following turn did not call update_status. */
  stale?: boolean;
}

/** A PR's live state on its host (0052) — the /api/x/prs answer, shaped
 *  here rather than imported from the seam so plan.ts stays free of
 *  server-side imports (client- and server-safe). */
export interface PRState {
  state: "open" | "merged" | "closed";
  mergedAt?: string;
}

/** 0052: the chip's live override — a PR-open phase relabeled by what
 *  the host says now (merged → ok, closed → warn; the URL stays the
 *  link). Everything else — no phase, another phase, an unknown or
 *  still-open answer — keeps the derived phase. */
export function applyPRState(phase: Phase | null, live: PRState | null): Phase | null {
  if (!phase || phase.kind !== "pr-open" || !live) return phase;
  if (live.state === "merged") return { ...phase, label: "PR merged", tone: "ok" };
  if (live.state === "closed") return { ...phase, label: "PR closed", tone: "warn" };
  return phase;
}

/**
 * The phase chip, derived — never stored (0041). PR states win, then a
 * plan still in review. Otherwise the label is the thread outline
 * (0064). A chat that never called `update_outline` has no chip — the
 * checklist count ("Building N/M") is gone.
 */
export function derivePhase(events: readonly PhaseEvent[], outline?: DerivedOutline | null): Phase | null {
  let plan: { version: number; open: boolean } | null = null;
  let approved = false;
  let pr: { state: "pending" | "open"; url?: string } | null = null;
  for (const e of events) {
    switch (e.type) {
      case "plan":
        // A review snapshot (first plan, or reapprove) reopens approval.
        if (e.status === "review") approved = false;
        plan = { version: e.version, open: e.status === "review" };
        break;
      case "plan-approved":
        approved = true;
        if (plan) plan.open = false;
        break;
      case "pr-pending":
        pr = { state: "pending" };
        break;
      case "pr-open":
        pr = { state: "open", ...(e.url ? { url: e.url } : {}) };
        break;
      case "pr-not-opened":
        if (pr?.state === "pending") pr = null;
        break;
    }
  }
  if (pr?.state === "pending") return { label: "PR · needs you", tone: "warn" };
  if (pr?.state === "open") return { label: "PR open", tone: "ok", kind: "pr-open", ...(pr.url ? { url: pr.url } : {}) };
  if (plan?.open && !approved) return { label: `Plan v${plan.version} · needs you`, tone: "warn" };
  if (outline?.current) {
    const chip = outlineChip(outline);
    if (chip) return { ...chip, ...(outline.stale ? { stale: true } : {}) };
  }
  return null;
}

/** Header chip from one transcript: plan/PR events plus the derived outline. */
export function phaseFromMessages(messages: readonly UIMessage[]): Phase | null {
  return derivePhase(phaseEvents(messages), deriveOutline(messages));
}

type LoosePart = { type: string; state?: string; output?: unknown; toolCallId?: string; text?: string };

/** The approval wake's text (lib/chat/wake renderWake) — matched too,
 *  because a wake that arrives mid-turn is queued as a steer and its
 *  row carries no runEvent metadata. */
const APPROVAL_WAKE = /^\[plan v\d+ approved\]/;

function isApprovalWake(message: UIMessage): boolean {
  if (message.role !== "user") return false;
  const runEvent = (message.metadata as { runEvent?: { kind?: string; status?: string } } | undefined)?.runEvent;
  if (runEvent?.kind === "plan" && runEvent.status === "approved") return true;
  return message.parts.some((p) => p.type === "text" && APPROVAL_WAKE.test((p as LoosePart).text ?? ""));
}

/** The phase events in a UI transcript (live or rebuilt from rows). */
export function phaseEvents(messages: readonly UIMessage[]): PhaseEvent[] {
  const events: PhaseEvent[] = [];
  for (const message of messages) {
    if (isApprovalWake(message)) events.push({ type: "plan-approved" });
    for (const raw of message.parts) {
      const part = raw as LoosePart;
      if (part.type === "tool-present_plan" && part.state === "output-available" && isPlanSnapshot(part.output)) {
        const s = part.output;
        events.push({ type: "plan", version: s.version, status: s.status, checklist: s.checklist });
      } else if (part.type === "tool-accept_plan" && part.state === "output-available") {
        if ((part.output as { approved?: unknown } | undefined)?.approved === true) events.push({ type: "plan-approved" });
      } else if (part.type === "tool-create_pr") {
        if (part.state === "input-available") events.push({ type: "pr-pending" });
        else if (part.state === "output-available") {
          const url = (part.output as { url?: unknown } | undefined)?.url;
          events.push(typeof url === "string" ? { type: "pr-open", url } : { type: "pr-not-opened" });
        } else if (part.state === "output-error") events.push({ type: "pr-not-opened" });
      }
    }
  }
  return events;
}

/** Per present_plan call in a transcript: the previous snapshot's
 *  markdown (for "changes since") and whether it is the latest one. */
export interface PlanHistory {
  previous: Map<string, { version: number; markdown: string }>;
  latestId: string | null;
  /** The latest snapshot's call, when it is a review Chad has not approved. */
  openReviewId: string | null;
}

export function planHistory(messages: readonly UIMessage[]): PlanHistory {
  const previous = new Map<string, { version: number; markdown: string }>();
  let last: { id: string; version: number; markdown: string; status: string } | null = null;
  let approvedAfterLast = false;
  for (const message of messages) {
    if (isApprovalWake(message)) approvedAfterLast = true;
    for (const raw of message.parts) {
      const part = raw as LoosePart;
      if (part.type === "tool-accept_plan" && part.state === "output-available") {
        if ((part.output as { approved?: unknown } | undefined)?.approved === true) approvedAfterLast = true;
      }
      if (part.type !== "tool-present_plan" || part.state !== "output-available" || !isPlanSnapshot(part.output)) continue;
      const id = part.toolCallId ?? "";
      if (last) previous.set(id, { version: last.version, markdown: last.markdown });
      last = { id, version: part.output.version, markdown: part.output.markdown, status: part.output.status };
      approvedAfterLast = false;
    }
  }
  return {
    previous,
    latestId: last?.id ?? null,
    openReviewId: last && last.status === "review" && !approvedAfterLast ? last.id : null,
  };
}
