/**
 * 0064: legacy read-compat for 0059 `update_status` results, plus the
 * transcript walkers the outline derivation (lib/outline.ts) shares.
 * `update_status` no longer exists as a tool; old transcripts still
 * carry its results and lib/outline.ts adapts them. No db import
 * (client- and workflow-safe).
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

const WAKE_KINDS = new Set(["harness", "thread", "plan", "outline"]);
/** `renderWake`'s first line (`[name word] — url`). */
const WAKE_TEXT = /^\[[^\]]+\] — /;

export function unwrapOutput(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const boxed = output as { type?: unknown; value?: unknown };
  if (boxed.type === "json" && "value" in boxed) return boxed.value;
  return output;
}

export function partsOf(message: unknown): unknown[] {
  if (!message || typeof message !== "object") return [];
  const record = message as { parts?: unknown; content?: unknown };
  if (Array.isArray(record.parts)) return record.parts;
  if (Array.isArray(record.content)) return record.content;
  return [];
}

export function textOf(message: unknown): string {
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

export function toolNameOf(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const record = part as { toolName?: unknown; type?: unknown };
  if (typeof record.toolName === "string") return record.toolName;
  if (typeof record.type === "string" && record.type.startsWith("tool-")) return record.type.slice("tool-".length);
  return null;
}

export function isWake(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  if ((message as { role?: unknown }).role !== "user") return false;
  const kind = (message as { metadata?: { runEvent?: { kind?: unknown } } }).metadata?.runEvent?.kind;
  if (typeof kind === "string" && WAKE_KINDS.has(kind)) return true;
  return WAKE_TEXT.test(textOf(message).trim());
}

export function hasUnresolvedTools(message: unknown): boolean {
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
