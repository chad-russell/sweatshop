import { STATUS_STATES, type StatusSnapshot, type StatusState, type StatusStep } from "@/lib/status";

/**
 * 0059: `update_status`'s core. Rewrites the whole status — the tool
 * result IS the snapshot the transcript derives from. No sqlite. The
 * workflow step is a thin wrapper.
 */

const STATE_SET = new Set<string>(STATUS_STATES);

type Fail = { ok: false; code: "invalid"; message: string };

function asStep(value: unknown, allowChildren: boolean): StatusStep | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { label?: unknown; state?: unknown; detail?: unknown; children?: unknown };
  if (typeof raw.label !== "string" || raw.label.trim() === "") return null;
  if (typeof raw.state !== "string" || !STATE_SET.has(raw.state)) return null;
  if (raw.detail !== undefined && typeof raw.detail !== "string") return null;
  const step: StatusStep = { label: raw.label.trim(), state: raw.state as StatusState };
  if (typeof raw.detail === "string" && raw.detail.trim()) step.detail = raw.detail.trim();
  if (raw.children === undefined) return step;
  if (!allowChildren || !Array.isArray(raw.children)) return null;
  const children: StatusStep[] = [];
  for (const child of raw.children) {
    const parsed = asStep(child, false);
    if (!parsed) return null;
    children.push(parsed);
  }
  if (children.length > 0) step.children = children;
  return step;
}

/** Validate and normalize a whole-status rewrite. */
export function updateStatus(input: unknown): StatusSnapshot | Fail {
  if (!input || typeof input !== "object") return { ok: false, code: "invalid", message: "status needs steps" };
  const raw = input as { steps?: unknown; note?: unknown };
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    return { ok: false, code: "invalid", message: "status needs at least one step" };
  }
  if (raw.steps.length > 50) return { ok: false, code: "invalid", message: "at most 50 steps" };
  const steps: StatusStep[] = [];
  for (const item of raw.steps) {
    const step = asStep(item, true);
    if (!step) return { ok: false, code: "invalid", message: "each step needs a label and a state (pending, active, done, skipped, blocked); children are one level" };
    if (step.children && step.children.length > 50) return { ok: false, code: "invalid", message: "at most 50 children on a step" };
    steps.push(step);
  }
  if (raw.note !== undefined && typeof raw.note !== "string") return { ok: false, code: "invalid", message: "note must be text" };
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  return note ? { ok: true, steps, note } : { ok: true, steps };
}
