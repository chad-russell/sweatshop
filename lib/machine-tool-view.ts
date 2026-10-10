import { objectOf } from "./tool-fields";

/**
 * Normalisers for the inspect / exec / transition tool results. The tools return
 * value-shaped JSON (`{ok:true,…}` or `{ok:false,code,message,issues}`), so a
 * card can read success vs. failure without guessing. Everything here is pure
 * and defensive: model-supplied input and stored output are never trusted to
 * have every field.
 */

export type ToolState = "running" | "completed" | "error";

/** The tool's own failure (`ok:false`) as a value, if it is one. */
export interface ToolFailure {
  code: string;
  message: string;
  issues: string[];
}

export function failureOf(output: unknown): ToolFailure | undefined {
  const o = objectOf(output);
  if (!o || o.ok !== false) return undefined;
  const issues = objectOf(o.issues);
  const flat: string[] = [];
  if (issues) {
    for (const [id, msgs] of Object.entries(objectOf(issues.stages) ?? {})) {
      for (const m of Array.isArray(msgs) ? msgs : []) flat.push(`${id}: ${String(m)}`);
    }
    for (const [id, msgs] of Object.entries(objectOf(issues.transitions) ?? {})) {
      for (const m of Array.isArray(msgs) ? msgs : []) flat.push(`${id}: ${String(m)}`);
    }
    for (const m of Array.isArray(issues.general) ? issues.general : []) flat.push(String(m));
  }
  return {
    code: typeof o.code === "string" ? o.code : "error",
    message: typeof o.message === "string" ? o.message : "the tool reported a failure",
    issues: flat,
  };
}

// --- edit ops -----------------------------------------------------------------


// --- machines -----------------------------------------------------------------

/** `{ok:true, machine}` (get / create / edit) → the machine, or undefined. */
// --- runs & inspect -------------------------------------------------------------

export interface InspectView {
  kind: string;
  id: string;
  title?: string;
  machine?: string;
  status?: string;
  currentStage?: string;
  error?: string;
  prompt?: string;
  busy?: boolean;
  messages?: number;
  sandbox?: string;
  visits: { seq: number; stage: string; kind: string; harness?: string; status: string; to?: string; outcome?: string; error?: string }[];
  harnessRuns: { harness: string; status: string; toolCalls: number; error?: string }[];
}

function sandboxLabel(value: unknown): string | undefined {
  const s = objectOf(value);
  if (!s) return undefined;
  if (typeof s.sandboxId === "string") return s.sandboxId;
  if (typeof s.state === "string") return s.state;
  return undefined;
}

export function inspectOf(output: unknown): InspectView | undefined {
  const o = objectOf(output);
  if (!o || typeof o.kind !== "string" || typeof o.id !== "string") return undefined;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const harness = objectOf(o.harness);
  return {
    kind: o.kind,
    id: o.id,
    title: str("title"),
    machine: str("machine"),
    status: str("status"),
    currentStage: str("currentStage"),
    error: str("error"),
    prompt: str("prompt"),
    busy: typeof o.busy === "boolean" ? o.busy : undefined,
    messages: typeof o.totalMessages === "number" ? o.totalMessages : undefined,
    sandbox: sandboxLabel(o.sandbox),
    visits: (Array.isArray(o.visits) ? o.visits : []).map((v) => {
      const x = objectOf(v) ?? {};
      return {
        seq: typeof x.seq === "number" ? x.seq : 0,
        stage: typeof x.stage === "string" ? x.stage : "?",
        kind: typeof x.kind === "string" ? x.kind : "?",
        ...(typeof x.harness === "string" ? { harness: x.harness } : {}),
        status: typeof x.status === "string" ? x.status : "?",
        ...(typeof x.to === "string" ? { to: x.to } : {}),
        ...(typeof x.outcome === "string" ? { outcome: x.outcome } : {}),
        ...(typeof x.error === "string" ? { error: x.error } : {}),
      };
    }),
    harnessRuns: (Array.isArray(harness?.runs) ? (harness!.runs as unknown[]) : []).map((r) => {
      const x = objectOf(r) ?? {};
      return {
        harness: typeof x.harness === "string" ? x.harness : "?",
        status: typeof x.status === "string" ? x.status : "?",
        toolCalls: typeof x.toolCalls === "number" ? x.toolCalls : 0,
        ...(typeof x.error === "string" ? { error: x.error } : {}),
      };
    }),
  };
}

export interface ExecView {
  sandboxId?: string;
  workDir?: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
}

export function execOf(output: unknown): ExecView | undefined {
  const o = objectOf(output);
  if (!o || (typeof o.stdout !== "string" && typeof o.exitCode !== "number")) return undefined;
  return {
    sandboxId: typeof o.sandboxId === "string" ? o.sandboxId : undefined,
    workDir: typeof o.workDir === "string" ? o.workDir : undefined,
    exitCode: typeof o.exitCode === "number" ? o.exitCode : undefined,
    stdout: typeof o.stdout === "string" ? o.stdout : "",
    stderr: typeof o.stderr === "string" ? o.stderr : "",
  };
}

export function transitionOf(input: unknown, output: unknown): { to: string; reason?: string; ok: boolean; note?: string } {
  const i = objectOf(input);
  const o = objectOf(output);
  return {
    to: typeof o?.to === "string" ? o.to : typeof i?.to === "string" ? i.to : "?",
    ...(typeof i?.reason === "string" && i.reason ? { reason: i.reason } : {}),
    ok: o ? o.ok !== false : true,
    ...(typeof o?.note === "string" ? { note: o.note } : {}),
  };
}
