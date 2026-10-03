import { objectOf } from "./tool-fields";

/**
 * Normalisers for the machine / run / inspect tool results. The tools return
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

export interface OpLine {
  /** add | remove | change | link | unlink | flag */
  tone: "add" | "remove" | "change" | "link" | "unlink";
  /** The headline: "Add stage Lint". */
  text: string;
  /** Secondary detail: what changed. */
  detail?: string;
}

function patchDetail(patch: unknown): string | undefined {
  const p = objectOf(patch);
  if (!p) return undefined;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (k === "instructions") parts.push("instructions");
    else if (v === null) parts.push(`${k} cleared`);
    else parts.push(`${k} → ${String(v)}`);
  }
  return parts.length ? parts.join(", ") : undefined;
}

export function describeOps(ops: unknown): OpLine[] {
  if (!Array.isArray(ops)) return [];
  return ops.map((raw): OpLine => {
    const o = objectOf(raw) ?? {};
    const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "?");
    switch (o.op) {
      case "add_stage":
        return {
          tone: "add",
          text: `Add ${typeof o.kind === "string" ? o.kind : ""} stage ${typeof o.title === "string" ? o.title : typeof o.id === "string" ? o.id : ""}`.replace(/\s+/g, " ").trim(),
        };
      case "update_stage":
        return { tone: "change", text: `Update ${s("stage")}`, detail: patchDetail(o.patch) };
      case "set_kind":
        return { tone: "change", text: `Make ${s("stage")} a ${s("kind")} stage` };
      case "rename_stage":
        return { tone: "change", text: `Rename ${s("from")} → ${s("to")}` };
      case "remove_stage":
        return { tone: "remove", text: `Remove stage ${s("stage")}` };
      case "connect":
        return {
          tone: "link",
          text: `${s("source")} → ${s("target")}`,
          detail: typeof o.when === "string" && o.when ? o.when : undefined,
        };
      case "disconnect":
        return { tone: "unlink", text: `${s("source")} ⇢ ${s("target")}` };
      case "update_transition":
        return { tone: "change", text: `Relabel ${s("source")} → ${s("target")}`, detail: typeof o.when === "string" ? o.when || "label removed" : undefined };
      case "set_start":
        return { tone: "change", text: `Start at ${s("stage")}` };
      case "set_workspace":
        return { tone: "change", text: `Workspace → ${s("workspace")}` };
      default:
        return { tone: "change", text: typeof o.op === "string" ? o.op : "edit" };
    }
  });
}

// --- machines -----------------------------------------------------------------

export interface FlowStage {
  id: string;
  title: string;
  kind: string;
  harness?: string;
  next: string[];
}

export interface MachineView {
  id: string;
  name: string;
  description: string | null;
  workspace: string;
  version: number | undefined;
  stageCount: number | undefined;
  /** In walk order from the start stage, when a full definition is present. */
  flow: FlowStage[];
}

function flowOf(definition: unknown): FlowStage[] {
  const def = objectOf(definition);
  const stages = objectOf(def?.stages);
  if (!def || !stages) return [];
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = typeof def.start === "string" ? [def.start] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id) || !stages[id]) continue;
    seen.add(id);
    order.push(id);
    const next = Array.isArray(objectOf(stages[id])?.next) ? (objectOf(stages[id])!.next as unknown[]) : [];
    for (const t of next) {
      const to = objectOf(t)?.to;
      if (typeof to === "string") queue.push(to);
    }
  }
  for (const id of Object.keys(stages)) if (!seen.has(id)) order.push(id); // unreachable stages still show
  return order.map((id) => {
    const st = objectOf(stages[id]) ?? {};
    const next = (Array.isArray(st.next) ? st.next : [])
      .map((t) => objectOf(t)?.to)
      .filter((t): t is string => typeof t === "string");
    return {
      id,
      title: typeof st.title === "string" ? st.title : id,
      kind: typeof st.kind === "string" ? st.kind : "?",
      ...(typeof st.harness === "string" ? { harness: st.harness } : {}),
      next,
    };
  });
}

export function machineOf(value: unknown): MachineView | undefined {
  const m = objectOf(value);
  if (!m || typeof m.id !== "string") return undefined;
  const flow = flowOf(m.definition);
  return {
    id: m.id,
    name: typeof m.name === "string" ? m.name : m.id,
    description: typeof m.description === "string" ? m.description : null,
    workspace: typeof m.workspace === "string" ? m.workspace : "",
    version: typeof m.version === "number" ? m.version : undefined,
    stageCount: typeof m.stages === "number" ? m.stages : flow.length || undefined,
    flow,
  };
}

/** `{ok:true, machine}` (get / create / edit) → the machine, or undefined. */
export function machineResult(output: unknown): MachineView | undefined {
  const o = objectOf(output);
  return o && o.ok !== false ? machineOf(o.machine) : undefined;
}

export function machineList(output: unknown): MachineView[] {
  const o = objectOf(output);
  const list = Array.isArray(o?.machines) ? (o!.machines as unknown[]) : [];
  return list.map(machineOf).filter((m): m is MachineView => !!m);
}

// --- runs & inspect -------------------------------------------------------------

export function runStarted(output: unknown): { runId: string; url: string; sandbox: string } | undefined {
  const o = objectOf(output);
  if (!o || typeof o.runId !== "string") return undefined;
  return {
    runId: o.runId,
    url: typeof o.url === "string" ? o.url : `/r/${o.runId}`,
    sandbox: typeof o.sandbox === "string" ? o.sandbox : "",
  };
}

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
