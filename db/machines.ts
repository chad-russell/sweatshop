import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./index";
import { machineRuns, machines, machineStageRuns, projects } from "./schema";
import type { MachineRow, MachineRun, MachineStageRun } from "./schema";
import {
  parseDefinition,
  type MachineDefinition,
} from "../lib/machines/definition";

/**
 * 0009 machines store. Invariants live here (routes and UI mirror them):
 *
 * - a stored definition always validates (parseDefinition);
 * - every definition change bumps `version`;
 * - a run freezes its machine's definition at start and binds a project
 *   iff the machine's workspace is "project" (and the project exists);
 * - stage visits are numbered 0.. per run, append-only.
 */

export type MachineErrorCode = "not-found" | "invalid";

export class MachineError extends Error {
  constructor(
    readonly code: MachineErrorCode,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
    this.name = "MachineError";
  }
}

export interface Machine extends Omit<MachineRow, "definition"> {
  definition: MachineDefinition;
}

function hydrate(row: MachineRow): Machine {
  // Stored definitions were validated on write; parse (not cast) so a
  // hand-edited row fails loudly here rather than deep inside a run.
  const parsed = parseDefinition(JSON.parse(row.definition));
  if (!parsed.ok) {
    throw new MachineError("invalid", `machine ${row.id} has an invalid stored definition`, parsed.errors);
  }
  return { ...row, definition: parsed.definition };
}

function requireDefinition(value: unknown): MachineDefinition {
  const parsed = parseDefinition(value);
  if (!parsed.ok) throw new MachineError("invalid", "invalid machine definition", parsed.errors);
  return parsed.definition;
}

function cleanName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MachineError("invalid", "name is required");
  }
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function cleanDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new MachineError("invalid", "description must be a string");
  return value.trim().slice(0, 500) || null;
}

const MACHINE_ID = /^[a-z][a-z0-9-]{0,47}$/;

// --- machines (CRUD) -------------------------------------------------------

export function listMachines(db: Db): Machine[] {
  return db.select().from(machines).orderBy(machines.name).all().map(hydrate);
}

export function getMachine(db: Db, id: string): Machine {
  const row = db.select().from(machines).where(eq(machines.id, id)).get();
  if (!row) throw new MachineError("not-found", `machine ${id} not found`);
  return hydrate(row);
}

export function createMachine(
  db: Db,
  input: { id?: unknown; name: unknown; description?: unknown; definition: unknown },
  now = Date.now(),
): Machine {
  let id: string;
  if (input.id === undefined) id = `m-${randomUUID().slice(0, 8)}`;
  else if (typeof input.id === "string" && MACHINE_ID.test(input.id)) id = input.id;
  else throw new MachineError("invalid", "id must be lowercase kebab-case (≤48 chars)");
  if (db.select({ id: machines.id }).from(machines).where(eq(machines.id, id)).get()) {
    throw new MachineError("invalid", `machine ${id} already exists`);
  }
  const definition = requireDefinition(input.definition);
  db.insert(machines)
    .values({
      id,
      name: cleanName(input.name),
      description: cleanDescription(input.description),
      definition: JSON.stringify(definition),
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getMachine(db, id);
}

export function updateMachine(
  db: Db,
  id: string,
  patch: { name?: unknown; description?: unknown; definition?: unknown },
  now = Date.now(),
): Machine {
  const current = getMachine(db, id);
  const set: Partial<MachineRow> = { updatedAt: now };
  if (patch.name !== undefined) set.name = cleanName(patch.name);
  if (patch.description !== undefined) set.description = cleanDescription(patch.description);
  if (patch.definition !== undefined) {
    const next = JSON.stringify(requireDefinition(patch.definition));
    if (next !== JSON.stringify(current.definition)) {
      set.definition = next;
      set.version = current.version + 1;
    }
  }
  db.update(machines).set(set).where(eq(machines.id, id)).run();
  return getMachine(db, id);
}

export function deleteMachine(db: Db, id: string): void {
  getMachine(db, id);
  // Runs keep their snapshot; machine_id goes null (FK on delete set null).
  db.delete(machines).where(eq(machines.id, id)).run();
}

// --- runs ------------------------------------------------------------------

export interface RunView extends Omit<MachineRun, "definition"> {
  definition: MachineDefinition;
}

function hydrateRun(row: MachineRun): RunView {
  return { ...row, definition: JSON.parse(row.definition) as MachineDefinition };
}

/** Create the run row (status running) — the trigger then start()s the workflow. */
export function createRun(
  db: Db,
  input: { machineId: string; prompt: unknown; projectId?: unknown },
  now = Date.now(),
): RunView {
  const machine = getMachine(db, input.machineId);
  if (typeof input.prompt !== "string" || !input.prompt.trim()) {
    throw new MachineError("invalid", "prompt is required");
  }
  let projectId: string | null = null;
  if (machine.definition.workspace === "project") {
    if (typeof input.projectId !== "string" || !input.projectId) {
      throw new MachineError("invalid", `machine ${machine.id} needs a project`);
    }
    const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get();
    if (!project) throw new MachineError("not-found", `project ${input.projectId} not found`);
    projectId = project.id;
  } else if (input.projectId) {
    throw new MachineError("invalid", `machine ${machine.id} does not use a project workspace`);
  }
  const id = `mr_${now.toString(36)}${randomUUID().replace(/-/g, "").slice(0, 6)}`;
  db.insert(machineRuns)
    .values({
      id,
      machineId: machine.id,
      machineName: machine.name,
      machineVersion: machine.version,
      definition: JSON.stringify(machine.definition),
      projectId,
      prompt: input.prompt.trim().slice(0, 50_000),
      status: "running",
      currentStage: machine.definition.start,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getRun(db, id);
}

export function getRun(db: Db, id: string): RunView {
  const row = db.select().from(machineRuns).where(eq(machineRuns.id, id)).get();
  if (!row) throw new MachineError("not-found", `run ${id} not found`);
  return hydrateRun(row);
}

export function listRuns(
  db: Db,
  filter: { projectId?: string; machineId?: string; limit?: number } = {},
): RunView[] {
  const conds = [];
  if (filter.projectId) conds.push(eq(machineRuns.projectId, filter.projectId));
  if (filter.machineId) conds.push(eq(machineRuns.machineId, filter.machineId));
  return db
    .select()
    .from(machineRuns)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(machineRuns.createdAt))
    .limit(Math.min(filter.limit ?? 50, 200))
    .all()
    .map(hydrateRun);
}

export function updateRun(
  db: Db,
  id: string,
  set: Partial<Pick<MachineRun, "status" | "currentStage" | "containerName" | "error">>,
  now = Date.now(),
): void {
  db.update(machineRuns).set({ ...set, updatedAt: now }).where(eq(machineRuns.id, id)).run();
}

// --- stage visits -----------------------------------------------------------

export function listStageRuns(db: Db, runId: string): MachineStageRun[] {
  return db
    .select()
    .from(machineStageRuns)
    .where(eq(machineStageRuns.runId, runId))
    .orderBy(machineStageRuns.seq)
    .all();
}

export function getStageRun(db: Db, runId: string, seq: number): MachineStageRun | null {
  return (
    db
      .select()
      .from(machineStageRuns)
      .where(and(eq(machineStageRuns.runId, runId), eq(machineStageRuns.seq, seq)))
      .get() ?? null
  );
}

/** Begin a stage visit. Idempotent per (run, seq): a replayed step reuses the row. */
export function beginStageRun(
  db: Db,
  input: { runId: string; seq: number; stageId: string; kind: string; harness?: string | null; sessionId?: string | null },
  now = Date.now(),
): MachineStageRun {
  db.insert(machineStageRuns)
    .values({
      runId: input.runId,
      seq: input.seq,
      stageId: input.stageId,
      kind: input.kind,
      harness: input.harness ?? null,
      status: input.kind === "human" ? "waiting" : "running",
      sessionId: input.sessionId ?? null,
      startedAt: now,
    })
    .onConflictDoNothing()
    .run();
  return getStageRun(db, input.runId, input.seq)!;
}

export function updateStageRun(
  db: Db,
  runId: string,
  seq: number,
  set: Partial<Pick<MachineStageRun, "status" | "sessionId" | "outcome" | "transitionTo" | "steps" | "error" | "endedAt">>,
): void {
  db.update(machineStageRuns)
    .set(set)
    .where(and(eq(machineStageRuns.runId, runId), eq(machineStageRuns.seq, seq)))
    .run();
}

/** Runs waiting on Chad (human gates) — the inbox's machine cards. */
export function listWaitingGates(db: Db): { run: RunView; stage: MachineStageRun }[] {
  const waiting = db
    .select()
    .from(machineStageRuns)
    .where(and(eq(machineStageRuns.kind, "human"), eq(machineStageRuns.status, "waiting")))
    .all();
  if (waiting.length === 0) return [];
  const runs = db
    .select()
    .from(machineRuns)
    .where(inArray(machineRuns.id, waiting.map((w) => w.runId)))
    .all();
  const byId = new Map(runs.map((r) => [r.id, hydrateRun(r)]));
  return waiting
    .filter((stage) => byId.get(stage.runId)?.status === "waiting")
    .map((stage) => ({ run: byId.get(stage.runId)!, stage }));
}

/** Stage-visit token (`<runId>:<seq>`) ↔ parts. */
export function visitToken(runId: string, seq: number): string {
  return `${runId}:${seq}`;
}

export function parseVisitToken(token: string): { runId: string; seq: number } | null {
  const m = /^(mr_[a-z0-9]+):(\d+)$/.exec(token);
  return m ? { runId: m[1]!, seq: Number(m[2]) } : null;
}

/** Harness session key for a stage visit (harness_events / /h routes). */
export function stageSessionId(runId: string, seq: number): string {
  return `${runId}_${seq}`;
}

/**
 * Where a run's repos are cloned inside its container (0009). Not
 * /workspace: pi runs in-process and probes whether the sandbox workdir
 * is ALSO visible on the host — in the dev runtime /workspace is the
 * repo bind mount, so pi would wrongly treat it as shared and read and
 * write the host's checkout. A per-run root never exists on the host,
 * so pi correctly mirrors through the sandbox.
 */
export function runWorkspaceRoot(runId: string): string {
  return `/work/${runId}`;
}
