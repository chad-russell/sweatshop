import { db } from "@/db";
import {
  createMachine,
  deleteMachine,
  getMachine,
  listMachines,
  MachineError,
  updateMachine,
  type Machine,
} from "@/db/machines";
import { parseDefinition } from "@/lib/machines/definition";
import { applyOps, issuesByElement, type EditOp } from "@/lib/machines/edit";

/**
 * 0015 Part A — machine tools' cores. Plain functions over db/machines
 * + lib/machines/edit (the workflow steps wrap them; the editor edits
 * through the same ops). Available in every chat: no sandbox or project
 * needed, and nothing here touches this conversation's sandbox.
 *
 * Errors come back as values — `{ ok: false, code, message, … }` — so
 * the model reads them and recovers instead of the call just failing.
 * editMachineTool is synchronous end to end (better-sqlite3 is
 * single-connection), so its read-check-write cannot interleave with
 * another edit in this process.
 */

export interface MachineSummary {
  id: string;
  name: string;
  description: string | null;
  workspace: "project" | "none";
  version: number;
  stages: number;
}

export interface MachineIssues {
  /** Stage id → messages. */
  stages: Record<string, string[]>;
  /** `source->target` → messages. */
  transitions: Record<string, string[]>;
  /** Issues not tied to one element. */
  general: string[];
}

/** The shape of a draft (ids, kinds, transitions — not instructions),
 *  returned with invalid-batch errors so the model can repair its ops
 *  without re-reading the whole definition. */
export interface DraftShape {
  start: string;
  stages: { id: string; kind: string; next: { to: string; when?: string }[] }[];
}

export type MachineToolError = {
  ok: false;
  code: "not-found" | "invalid" | "conflict" | "denied";
  message: string;
  /** invalid: what is wrong, by element where possible. */
  issues?: MachineIssues;
  /** invalid (edit): the would-be draft's shape. */
  draft?: DraftShape;
  /** conflict: the version that is actually current. */
  currentVersion?: number;
};

function summarize(m: Machine): MachineSummary {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    workspace: m.definition.workspace,
    version: m.version,
    stages: Object.keys(m.definition.stages).length,
  };
}

function shapeOf(def: Machine["definition"]): DraftShape {
  return {
    start: def.start,
    stages: Object.entries(def.stages).map(([id, stage]) => ({
      id,
      kind: stage.kind,
      next: stage.next.map((t) => ({ to: t.to, ...(t.when ? { when: t.when } : {}) })),
    })),
  };
}

function elementIssues(def: Machine["definition"], errors: readonly string[]): MachineIssues {
  const placed = issuesByElement(def, errors);
  return {
    stages: Object.fromEntries(placed.nodes),
    transitions: Object.fromEntries(placed.edges),
    general: [...placed.general],
  };
}

/** Store errors (MachineError) → the value-shaped error; anything else is
 *  a programming error and still throws. */
function asError(error: unknown): MachineToolError {
  if (error instanceof MachineError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.details ? { issues: { stages: {}, transitions: {}, general: error.details } } : {}),
    };
  }
  throw error;
}

// --- reads -------------------------------------------------------------------

export function listMachinesCatalog(): { ok: true; machines: MachineSummary[] } {
  return { ok: true, machines: listMachines(db()).map(summarize) };
}

export function getMachineTool(
  id: string,
): { ok: true; machine: MachineSummary & { definition: unknown } } | MachineToolError {
  try {
    const m = getMachine(db(), id);
    return { ok: true, machine: { ...summarize(m), definition: m.definition } };
  } catch (error) {
    return asError(error);
  }
}

// --- write -------------------------------------------------------------------

/**
 * The approval preview for create_machine: validates WITHOUT writing, so
 * Chad is only asked about a machine that would actually be created (a
 * generation mistake comes straight back to the model to repair). The
 * write re-validates — this is a courtesy, not the guard.
 */
export function previewCreateMachine(input: {
  id?: string;
  name: string;
  definition: unknown;
}): { ok: true; summary: string } | MachineToolError {
  const parsed = parseDefinition(input.definition);
  if (!parsed.ok) return invalidDefinition(parsed.errors);
  if (input.id) {
    try {
      getMachine(db(), input.id);
      return { ok: false, code: "conflict", message: `machine ${input.id} already exists — edit it with edit_machine instead` };
    } catch (error) {
      if (!(error instanceof MachineError && error.code === "not-found")) return asError(error);
    }
  }
  const stages = Object.values(parsed.definition.stages);
  const kinds = stages.map((s) => (s.kind === "harness" ? s.harness : s.kind)).join(" → ");
  return {
    ok: true,
    summary:
      `Create machine "${input.name}"${input.id ? ` (${input.id})` : ""} — ${stages.length} ` +
      `${stages.length === 1 ? "stage" : "stages"}: ${kinds}; workspace ${parsed.definition.workspace}?`,
  };
}

function invalidDefinition(errors: string[]): MachineToolError {
  return {
    ok: false,
    code: "invalid",
    message: "the definition does not validate; nothing was created",
    issues: { stages: {}, transitions: {}, general: errors },
  };
}

export function createMachineTool(input: {
  id?: string;
  name: string;
  description?: string;
  definition: unknown;
}): { ok: true; machine: MachineSummary & { definition: unknown } } | MachineToolError {
  // Validate first so generation errors come back with the raw parse
  // issues (by-element placement needs a definition-shaped draft, which
  // a generated one may not be).
  const parsed = parseDefinition(input.definition);
  if (!parsed.ok) return invalidDefinition(parsed.errors);
  try {
    const m = createMachine(db(), { ...input, definition: parsed.definition });
    return { ok: true, machine: { ...summarize(m), definition: m.definition } };
  } catch (error) {
    return asError(error);
  }
}

export function editMachineTool(input: {
  id: string;
  /** The version the ops were planned against; a mismatch is a conflict. */
  baseVersion: number;
  ops: EditOp[];
  name?: string;
  description?: string;
}): { ok: true; machine: MachineSummary } | MachineToolError {
  let machine: Machine;
  try {
    machine = getMachine(db(), input.id);
  } catch (error) {
    return asError(error);
  }
  if (machine.version !== input.baseVersion) {
    return {
      ok: false,
      code: "conflict",
      message:
        `machine ${input.id} is at version ${machine.version}, not the baseVersion ${input.baseVersion} ` +
        "these ops were planned against. Re-read it with get_machine and retry against the new version.",
      currentVersion: machine.version,
    };
  }
  let draft: Machine["definition"];
  try {
    draft = applyOps(machine.definition, input.ops);
  } catch (error) {
    return {
      ok: false,
      code: "invalid",
      message:
        `an op cannot apply: ${error instanceof Error ? error.message : String(error)}. ` +
        "Nothing was saved.",
      issues: { stages: {}, transitions: {}, general: [] },
    };
  }
  const parsed = parseDefinition(draft);
  if (!parsed.ok) {
    return {
      ok: false,
      code: "invalid",
      message: `applying the ops would leave ${input.id} invalid; nothing was saved`,
      issues: elementIssues(draft, parsed.errors),
      draft: shapeOf(draft),
    };
  }
  const saved = updateMachine(
    db(),
    input.id,
    {
      definition: draft,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
  );
  return { ok: true, machine: summarize(saved) };
}

/** What the delete approval question shows (also proves the machine exists). */
export function machineDeletePreview(id: string): { ok: true; machine: MachineSummary } | MachineToolError {
  try {
    return { ok: true, machine: summarize(getMachine(db(), id)) };
  } catch (error) {
    return asError(error);
  }
}

export function deleteMachineTool(id: string): { ok: true; deleted: MachineSummary } | MachineToolError {
  try {
    const m = getMachine(db(), id);
    deleteMachine(db(), id);
    return { ok: true, deleted: summarize(m) };
  } catch (error) {
    return asError(error);
  }
}
