import {
  END,
  type MachineDefinition,
  type Stage,
  type StageHarness,
} from "./definition";
import { edgeId } from "./layout";

/**
 * 0014 edit operations: the only way the machine editor (and, in 0015,
 * the assistant) changes a definition. Each is pure — definition in,
 * new definition out — and never validates: a draft may pass through
 * invalid states while it is being rewired; the caller re-runs
 * parseDefinition and shows the issues (issuesByElement). Operations
 * that cannot apply (unknown stage, etc.) throw EditError.
 *
 * Kept data-shaped on purpose so an LLM tool can call them 1:1.
 */

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

export type StageKind = Stage["kind"];

/** Fields a stage update may set (kind changes go through setKind). */
export type StagePatch = Partial<{
  title: string;
  instructions: string;
  maxVisits: number | undefined;
  harness: StageHarness;
  model: string | undefined;
  thinking: "off" | "low" | "medium" | "high" | undefined;
}>;

const ID = /^[a-z][a-z0-9-]{0,39}$/;

function stageOf(def: MachineDefinition, id: string): Stage {
  const stage = def.stages[id];
  if (!stage) throw new EditError(`stage "${id}" does not exist`);
  return stage;
}

function withStage(def: MachineDefinition, id: string, stage: Stage): MachineDefinition {
  return { ...def, stages: { ...def.stages, [id]: stage } };
}

/** The first free `<base>`, `<base>-2`, `<base>-3`… id. */
export function freeStageId(def: MachineDefinition, base: string): string {
  const clean =
    base
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .replace(/-+$/, "")
      .slice(0, 36) || "stage";
  if (!def.stages[clean] && clean !== END) return clean;
  for (let n = 2; ; n += 1) {
    const id = `${clean}-${n}`;
    if (!def.stages[id]) return id;
  }
}

/** A blank stage of a kind (harness defaults to pi). */
export function blankStage(kind: StageKind, title: string): Stage {
  const common = { title, instructions: "", next: [] };
  if (kind === "harness") return { kind, harness: "pi", ...common };
  return { kind, ...common };
}

export function addStage(
  def: MachineDefinition,
  input: { id?: string; kind: StageKind; title?: string },
): { definition: MachineDefinition; id: string } {
  const title = input.title?.trim() || defaultTitle(input.kind);
  const id = input.id ?? freeStageId(def, title);
  if (!ID.test(id)) throw new EditError(`"${id}" is not a valid stage id (lowercase kebab-case, ≤40)`);
  if (id === END || def.stages[id]) throw new EditError(`stage "${id}" already exists`);
  return { definition: withStage(def, id, blankStage(input.kind, title)), id };
}

function defaultTitle(kind: StageKind): string {
  return kind === "harness" ? "Code" : kind === "agent" ? "Think" : "Review";
}

export function updateStage(def: MachineDefinition, id: string, patch: StagePatch): MachineDefinition {
  const stage = stageOf(def, id);
  const next: Record<string, unknown> = { ...stage };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "harness" || key === "thinking") {
      if (stage.kind !== "harness") throw new EditError(`${key} only applies to harness stages`);
    }
    if (key === "model" && stage.kind === "human") throw new EditError("human stages have no model");
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
  }
  return withStage(def, id, next as Stage);
}

/** Change a stage's kind, keeping title/instructions/next/maxVisits. */
export function setKind(def: MachineDefinition, id: string, kind: StageKind): MachineDefinition {
  const stage = stageOf(def, id);
  if (stage.kind === kind) return def;
  const { title, instructions, next, maxVisits } = stage;
  const base = { title, instructions, next, ...(maxVisits !== undefined ? { maxVisits } : {}) };
  const model = "model" in stage && stage.model && kind === "agent" && stage.kind === "agent" ? { model: stage.model } : {};
  const replaced: Stage =
    kind === "harness" ? { kind, harness: "pi", ...base } : kind === "agent" ? { kind, ...base, ...model } : { kind, ...base };
  return withStage(def, id, replaced);
}

/** Rename a stage id, rewriting `start` and every `next.to` that names it. */
export function renameStage(def: MachineDefinition, from: string, to: string): MachineDefinition {
  stageOf(def, from);
  if (from === to) return def;
  if (!ID.test(to)) throw new EditError(`"${to}" is not a valid stage id (lowercase kebab-case, ≤40)`);
  if (to === END || def.stages[to]) throw new EditError(`stage "${to}" already exists`);
  const stages: Record<string, Stage> = {};
  for (const [id, stage] of Object.entries(def.stages)) {
    const next = stage.next.map((t) => (t.to === from ? { ...t, to } : t));
    stages[id === from ? to : id] = { ...stage, next };
  }
  return { ...def, start: def.start === from ? to : def.start, stages };
}

/** Remove a stage and every transition into it. `start` is left dangling
 *  if it was the start (the editor surfaces that as an issue). */
export function removeStage(def: MachineDefinition, id: string): MachineDefinition {
  stageOf(def, id);
  const stages: Record<string, Stage> = {};
  for (const [sid, stage] of Object.entries(def.stages)) {
    if (sid === id) continue;
    stages[sid] = { ...stage, next: stage.next.filter((t) => t.to !== id) };
  }
  return { ...def, stages };
}

/** Add a transition (no-op if it already exists). */
export function connect(
  def: MachineDefinition,
  source: string,
  target: string,
  when?: string,
): MachineDefinition {
  const stage = stageOf(def, source);
  if (target !== END) stageOf(def, target);
  if (stage.next.some((t) => t.to === target)) return def;
  const transition = when?.trim() ? { to: target, when: when.trim() } : { to: target };
  return withStage(def, source, { ...stage, next: [...stage.next, transition] });
}

export function disconnect(def: MachineDefinition, source: string, target: string): MachineDefinition {
  const stage = stageOf(def, source);
  if (!stage.next.some((t) => t.to === target)) throw new EditError(`no transition ${source} → ${target}`);
  return withStage(def, source, { ...stage, next: stage.next.filter((t) => t.to !== target) });
}

/** Set (or clear, with "") a transition's `when` label. */
export function updateTransition(
  def: MachineDefinition,
  source: string,
  target: string,
  when: string,
): MachineDefinition {
  const stage = stageOf(def, source);
  if (!stage.next.some((t) => t.to === target)) throw new EditError(`no transition ${source} → ${target}`);
  const next = stage.next.map((t) =>
    t.to === target ? (when.trim() ? { to: t.to, when: when.trim() } : { to: t.to }) : t,
  );
  return withStage(def, source, { ...stage, next });
}

export function setStart(def: MachineDefinition, id: string): MachineDefinition {
  stageOf(def, id);
  return { ...def, start: id };
}

export function setWorkspace(def: MachineDefinition, workspace: MachineDefinition["workspace"]): MachineDefinition {
  return { ...def, workspace };
}

// --- issues → graph elements ---------------------------------------------

export interface ElementIssues {
  /** Stage id → messages. */
  nodes: Map<string, string[]>;
  /** Edge id (`source->target`) → messages. */
  edges: Map<string, string[]>;
  /** Issues not tied to one element (root, start, stage count). */
  general: string[];
}

/**
 * Place parseDefinition's `path: message` strings onto the node or edge
 * they name: `stages.<id>.next.<i>…` → that edge, `stages.<id>…` → that
 * node, anything else → general. Needs the (possibly invalid) draft to
 * resolve a `next` index to its target.
 */
export function issuesByElement(def: MachineDefinition, errors: readonly string[]): ElementIssues {
  const result: ElementIssues = { nodes: new Map(), edges: new Map(), general: [] };
  const add = (map: Map<string, string[]>, key: string, msg: string) => map.set(key, [...(map.get(key) ?? []), msg]);
  for (const error of errors) {
    const split = error.indexOf(": ");
    const path = split >= 0 ? error.slice(0, split) : "";
    const message = split >= 0 ? error.slice(split + 2) : error;
    const parts = path.split(".");
    if (parts[0] !== "stages" || !parts[1]) {
      result.general.push(error);
      continue;
    }
    const id = parts[1];
    const stage = def.stages[id];
    if (!stage) {
      result.general.push(error);
      continue;
    }
    if (parts[2] === "next" && parts[3] !== undefined) {
      const t = stage.next[Number(parts[3])];
      // A transition to a missing stage is not drawn (no target node),
      // so its issue goes on the source node instead.
      if (t && (t.to === END || def.stages[t.to])) {
        add(result.edges, edgeId(id, t.to), message);
        continue;
      }
    }
    const field = parts.slice(2).join(".");
    add(result.nodes, id, field ? `${field}: ${message}` : message);
  }
  return result;
}
