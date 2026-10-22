/**
 * 0059: thread status — the pure half. 0064 replaced the live
 * `update_status` tool with `update_outline` (lib/outline.ts, which reads
 * these same shapes for legacy compat); this module stays only for mode
 * machinery (lib/agent/mode-ids.ts, lib/chat/phase-handoff.ts,
 * components/mode-chip.tsx) still being read, untouched, ahead of its
 * removal. No db import (client- and workflow-safe, same rule as
 * lib/plan.ts).
 */

export const STATUS_STATES = ["pending", "active", "done", "skipped", "blocked"] as const;
export type StatusState = (typeof STATUS_STATES)[number];

const STATE_SET: ReadonlySet<string> = new Set(STATUS_STATES);

export interface StatusStep {
  label: string;
  state: StatusState;
  detail?: string;
  /** One level only — a phase's checklist. Grandchildren are not a step. */
  children?: StatusStep[];
}

/** What `update_status` returns. The transcript copy IS the status. */
export interface StatusSnapshot {
  ok: true;
  steps: StatusStep[];
  note?: string;
}

export interface DerivedStatus {
  current: StatusSnapshot | null;
  history: StatusSnapshot[];
  /** A wake followed by a completed assistant turn that did not call
   *  update_status. The chip says so instead of pretending the count
   *  is still right. */
  stale: boolean;
}

function isStep(value: unknown, allowChildren: boolean): value is StatusStep {
  if (!value || typeof value !== "object") return false;
  const step = value as Partial<StatusStep>;
  if (typeof step.label !== "string" || step.label.trim() === "") return false;
  if (typeof step.state !== "string" || !STATE_SET.has(step.state)) return false;
  if (step.detail !== undefined && typeof step.detail !== "string") return false;
  if (step.children === undefined) return true;
  if (!allowChildren || !Array.isArray(step.children)) return false;
  return step.children.every((child) => isStep(child, false));
}

export function isStatusSnapshot(value: unknown): value is StatusSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<StatusSnapshot>;
  if (snapshot.ok !== true || !Array.isArray(snapshot.steps) || snapshot.steps.length === 0) return false;
  if (!snapshot.steps.every((step) => isStep(step, true))) return false;
  if (snapshot.note !== undefined && typeof snapshot.note !== "string") return false;
  return true;
}

/** The first top-level step in `state`, else the first matching child. */
export function findStep(steps: readonly StatusStep[], state: StatusState): StatusStep | null {
  const top = steps.find((step) => step.state === state);
  if (top) return top;
  for (const step of steps) {
    const child = step.children?.find((item) => item.state === state);
    if (child) return child;
  }
  return null;
}

/** Active top-level labels in order, collapsing consecutive repeats. */
export function activeStepHistory(history: readonly StatusSnapshot[]): string[] {
  const out: string[] = [];
  for (const snapshot of history) {
    const label = snapshot.steps.find((step) => step.state === "active")?.label;
    if (label && out[out.length - 1] !== label) out.push(label);
  }
  return out;
}

const WAKE_KINDS = new Set(["harness", "thread", "plan"]);
/** `renderWake`'s first line (`[name word] — url`). */
const WAKE_TEXT = /^\[[^\]]+\] — /;

function unwrapOutput(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const boxed = output as { type?: unknown; value?: unknown };
  if (boxed.type === "json" && "value" in boxed) return boxed.value;
  return output;
}

function partsOf(message: unknown): unknown[] {
  if (!message || typeof message !== "object") return [];
  const record = message as { parts?: unknown; content?: unknown };
  if (Array.isArray(record.parts)) return record.parts;
  if (Array.isArray(record.content)) return record.content;
  return [];
}

function textOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return partsOf(message)
    .map((part) => {
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolNameOf(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const record = part as { toolName?: unknown; type?: unknown };
  if (typeof record.toolName === "string") return record.toolName;
  if (typeof record.type === "string" && record.type.startsWith("tool-")) return record.type.slice("tool-".length);
  return null;
}

function statusSnapshots(message: unknown): StatusSnapshot[] {
  const out: StatusSnapshot[] = [];
  for (const part of partsOf(message)) {
    if (toolNameOf(part) !== "update_status") continue;
    const state = (part as { state?: unknown }).state;
    if (typeof state === "string" && state !== "output-available") continue;
    const output = unwrapOutput((part as { output?: unknown; result?: unknown }).output ?? (part as { result?: unknown }).result);
    if (isStatusSnapshot(output)) out.push(output);
  }
  return out;
}

function isWake(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  if ((message as { role?: unknown }).role !== "user") return false;
  const kind = (message as { metadata?: { runEvent?: { kind?: unknown } } }).metadata?.runEvent?.kind;
  if (typeof kind === "string" && WAKE_KINDS.has(kind)) return true;
  return WAKE_TEXT.test(textOf(message).trim());
}

function hasUnresolvedTools(message: unknown): boolean {
  for (const part of partsOf(message)) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; state?: unknown };
    if (record.type === "tool-call") return true;
    if (typeof record.type === "string" && record.type.startsWith("tool-") && record.type !== "tool-result") {
      const state = record.state;
      if (state !== "output-available" && state !== "output-error" && state !== "output-denied") return true;
    }
  }
  return false;
}

/**
 * Current status, every prior rewrite, and the stale bit. Accepts UI
 * messages (`parts`) and model messages (`content`) so the chip, the
 * per-turn note, and phase handoff share one walk.
 */
export function deriveStatus(messages: readonly unknown[]): DerivedStatus {
  const history: StatusSnapshot[] = [];
  let current: StatusSnapshot | null = null;
  let stale = false;
  let buffer: unknown[] = [];
  let bufferWake = false;

  const applySnapshots = (snapshots: StatusSnapshot[]) => {
    if (snapshots.length === 0) return false;
    history.push(...snapshots);
    current = snapshots[snapshots.length - 1]!;
    stale = false;
    return true;
  };

  const flush = (ended: boolean) => {
    const snapshots = buffer.flatMap(statusSnapshots);
    if (bufferWake) {
      if (!applySnapshots(snapshots)) {
        const assistants = buffer.filter((message) => (message as { role?: unknown }).role === "assistant");
        if (assistants.length > 0) {
          const unresolved = hasUnresolvedTools(assistants[assistants.length - 1]);
          if ((ended || !unresolved) && current) stale = true;
        }
      }
    } else {
      applySnapshots(snapshots);
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
  return { current, history, stale };
}

/** Skill ids loaded in this transcript: owner mode entry, then each
 *  `use_skill({id})` that returned a body. First-seen order. */
export function skillsUsed(messages: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const runEvent = (message as { metadata?: { runEvent?: { kind?: unknown; id?: unknown } } }).metadata?.runEvent;
    if (runEvent?.kind === "mode" && typeof runEvent.id === "string" && runEvent.id) add(runEvent.id);
    for (const part of partsOf(message)) {
      if (toolNameOf(part) !== "use_skill") continue;
      const state = (part as { state?: unknown }).state;
      if (typeof state === "string" && state !== "output-available") continue;
      const output = unwrapOutput((part as { output?: unknown }).output);
      if (!output || typeof output !== "object") continue;
      const record = output as { ok?: unknown; id?: unknown };
      if (record.ok === true && typeof record.id === "string" && record.id) add(record.id);
    }
  }
  return out;
}

/** The latest `use_skill` result that loaded a mode, if the transcript has one. */
export function lastLoadedModeId(messages: readonly unknown[]): string | null {
  let id: string | null = null;
  for (const message of messages) {
    for (const part of partsOf(message)) {
      if (toolNameOf(part) !== "use_skill") continue;
      const state = (part as { state?: unknown }).state;
      if (typeof state === "string" && state !== "output-available") continue;
      const output = unwrapOutput((part as { output?: unknown }).output);
      if (!output || typeof output !== "object") continue;
      const record = output as { ok?: unknown; mode?: unknown; id?: unknown };
      if (record.ok === true && record.mode === true && typeof record.id === "string" && record.id) id = record.id;
    }
  }
  return id;
}
