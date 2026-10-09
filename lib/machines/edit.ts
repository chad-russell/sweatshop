import { z } from "zod";
import {
  END,
  HARNESSES,
  type MachineDefinition,
  type Stage,
  type StageHarness,
} from "./definition";
import { edgeId } from "./layout";
import { chatRouteSchema, harnessRouteSchema, type ChatRoute, type HarnessRoute } from "../providers/route";

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
    if (key === "harness" && stage.kind !== "harness") throw new EditError("harness only applies to harness stages");
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
  }
  // 0021: switching harness invalidates a pinned route of the other harness.
  const route = next.route as HarnessRoute | undefined;
  if (stage.kind === "harness" && route && route.harness !== next.harness) delete next.route;
  return withStage(def, id, next as Stage);
}

/**
 * 0021: pin (or, with null, clear) a stage's route. Agent stages take a
 * provider + model; harness stages a pi or claude route matching their
 * harness; human stages have none.
 */
export function setStageRoute(def: MachineDefinition, id: string, route: ChatRoute | HarnessRoute | null): MachineDefinition {
  const stage = stageOf(def, id);
  if (stage.kind === "human" || stage.kind === "publish") {
    throw new EditError("human and publish stages have no route");
  }
  const next: Record<string, unknown> = { ...stage };
  if (route === null) {
    delete next.route;
    return withStage(def, id, next as Stage);
  }
  if (stage.kind === "agent") {
    const parsed = chatRouteSchema.safeParse(route);
    if (!parsed.success) throw new EditError("an agent stage's route is { provider, model }");
    next.route = parsed.data;
  } else {
    const parsed = harnessRouteSchema.safeParse(route);
    if (!parsed.success) {
      throw new EditError(
        'a harness stage\'s route is { harness: "pi", provider, model, thinking? } or { harness: "claude", model?, effort? }',
      );
    }
    if (parsed.data.harness !== stage.harness) {
      throw new EditError(`route harness "${parsed.data.harness}" does not match the stage's harness "${stage.harness}"`);
    }
    next.route = parsed.data;
  }
  return withStage(def, id, next as Stage);
}

/** Change a stage's kind, keeping title/instructions/next/maxVisits
 *  (instructions only where the target kind has them — publish's is
 *  optional, a note for the graph reader). */
export function setKind(def: MachineDefinition, id: string, kind: StageKind): MachineDefinition {
  const stage = stageOf(def, id);
  if (stage.kind === kind) return def;
  const { title, instructions, next, maxVisits } = stage;
  if (instructions === undefined && (kind === "harness" || kind === "agent")) {
    throw new EditError(`a ${kind} stage needs instructions — set them on the stage first (update_stage)`);
  }
  const base = {
    title,
    ...(instructions !== undefined ? { instructions } : {}),
    next,
    ...(maxVisits !== undefined ? { maxVisits } : {}),
  };
  // A route never survives a kind change (its shape is per kind). The
  // guard above makes instructions present for harness/agent targets —
  // the spread alone can't prove it to the union.
  const replaced = (kind === "harness" ? { kind, harness: "pi", ...base } : { kind, ...base }) as Stage;
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

// --- batched operations (0015) ---------------------------------------------

/**
 * One edit operation, shaped for an LLM tool schema: mirrors the
 * functions above one to one. Optional fields set to `null` mean
 * "clear the field" (JSON has no undefined). Validated per-op by the
 * functions above, not by this schema — their EditError messages are
 * the precise ones the model reads.
 */
export const editOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_stage"),
    id: z.string().max(40).optional().describe("New stage id; omit to derive one from the title"),
    kind: z.enum(["harness", "agent", "human"]),
    title: z.string().min(1).max(80).optional().describe("Defaults by kind: Code / Think / Review"),
  }),
  z.object({
    op: z.literal("update_stage"),
    stage: z.string().describe("Stage id to patch"),
    patch: z
      .object({
        title: z.string().min(1).max(80).optional(),
        instructions: z.string().max(20_000).optional(),
        maxVisits: z.number().int().min(1).max(20).nullable().optional().describe("Loop bound; null clears it"),
        harness: z.enum(HARNESSES).optional().describe("pi or claude (harness stages only; clears a mismatched route)"),
      })
      .strict()
      .describe("Fields to set; absent fields keep their value, null clears"),
  }),
  z.object({
    op: z.literal("set_route"),
    stage: z.string(),
    route: z
      .union([harnessRouteSchema, chatRouteSchema])
      .nullable()
      .describe(
        'Pin the stage\'s model route. agent: { provider, model }; harness: { harness: "pi", provider, model, thinking? } ' +
          'or { harness: "claude", model?, effort? } (must match the stage\'s harness). null = inherit (run → project → global). ' +
          "provider is glm | gloo | openrouter.",
      ),
  }),
  z.object({
    op: z.literal("set_kind"),
    stage: z.string(),
    kind: z.enum(["harness", "agent", "human"]),
  }),
  z.object({
    op: z.literal("rename_stage"),
    from: z.string().describe("Existing stage id"),
    to: z.string().max(40).describe("New stage id (references are rewritten)"),
  }),
  z.object({ op: z.literal("remove_stage"), stage: z.string() }),
  z.object({
    op: z.literal("connect"),
    source: z.string(),
    target: z.string().describe(`Stage id or "${END}"`),
    when: z.string().max(400).optional().describe("Branch label shown to the chooser"),
  }),
  z.object({ op: z.literal("disconnect"), source: z.string(), target: z.string() }),
  z.object({
    op: z.literal("update_transition"),
    source: z.string(),
    target: z.string(),
    when: z.string().max(400).describe('New label; "" removes it'),
  }),
  z.object({ op: z.literal("set_start"), stage: z.string() }),
  z.object({
    op: z.literal("set_workspace"),
    workspace: z.enum(["project", "none"]).describe("none forbids harness stages"),
  }),
]);

export type EditOp = z.infer<typeof editOpSchema>;

/**
 * Apply ops in order to a definition — the batch entry the 0015 agent
 * tool (and a future "apply a proposal") uses. Pure; does NOT validate
 * the result: a batch may pass through invalid intermediate states and
 * end invalid, exactly like hand-editing in the editor — the caller
 * runs parseDefinition and decides. Throws EditError naming the op
 * index when an op cannot apply at all (unknown stage, bad id, …).
 */
export function applyOps(def: MachineDefinition, ops: readonly EditOp[]): MachineDefinition {
  let next = def;
  ops.forEach((op, i) => {
    try {
      switch (op.op) {
        case "add_stage":
          next = addStage(next, { id: op.id, kind: op.kind, title: op.title }).definition;
          break;
        case "update_stage":
          next = updateStage(next, op.stage, normalizePatch(op.patch));
          break;
        case "set_route":
          next = setStageRoute(next, op.stage, op.route);
          break;
        case "set_kind":
          next = setKind(next, op.stage, op.kind);
          break;
        case "rename_stage":
          next = renameStage(next, op.from, op.to);
          break;
        case "remove_stage":
          next = removeStage(next, op.stage);
          break;
        case "connect":
          next = connect(next, op.source, op.target, op.when);
          break;
        case "disconnect":
          next = disconnect(next, op.source, op.target);
          break;
        case "update_transition":
          next = updateTransition(next, op.source, op.target, op.when);
          break;
        case "set_start":
          next = setStart(next, op.stage);
          break;
        case "set_workspace":
          next = setWorkspace(next, op.workspace);
          break;
      }
    } catch (error) {
      throw new EditError(`op ${i} (${op.op}): ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return next;
}

/** Map patch nulls (JSON's "clear this field") to undefined, which
 *  updateStage deletes — the editor's own patch type has no null. */
function normalizePatch(patch: Record<string, unknown>): StagePatch {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) normalized[key] = value === null ? undefined : value;
  return normalized as StagePatch;
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
