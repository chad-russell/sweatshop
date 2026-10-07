import { runOverridesSchema, type RunOverrides } from "../lib/providers/route";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "./index";
import type { BoundSandbox } from "./sandboxes";
import { conversations, machineRuns, machines, machineStageRuns, projects } from "./schema";
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
 * - stage visits are numbered 0.. per run, append-only;
 * - 0012: every run IS a conversation — `createRun` writes the
 *   `kind = 'run'` conversations row (same id) in the same transaction,
 *   so a run is filed, archived, trashed, and searched like a chat;
 * - a cancelled run is final: later status writes are ignored (a step
 *   still in flight when the workflow was cancelled must not revive it).
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

export interface RunView extends Omit<MachineRun, "definition" | "overrides"> {
  /** The snapshot as stored. Pre-0021 snapshots may still carry the old
   *  stage `model`/`thinking` fields — history, read for display only
   *  and ignored by resolution (no run resumes across the migration). */
  definition: MachineDefinition;
  overrides: RunOverrides | null;
}

function hydrateRun(row: MachineRun): RunView {
  const overrides = row.overrides ? runOverridesSchema.safeParse(JSON.parse(row.overrides)) : null;
  return {
    ...row,
    definition: JSON.parse(row.definition) as MachineDefinition,
    overrides: overrides?.success ? overrides.data : null,
  };
}

/** 0021: record what ran a visit and which layer it resolved from. */
export function recordStageRoute(db: Db, runId: string, seq: number, resolved: { route: unknown; layer: string }): void {
  updateStageRun(db, runId, seq, { route: JSON.stringify(resolved) });
}

/** Create the run row (status running) — the trigger then start()s the workflow. */
export function createRun(
  db: Db,
  input: {
    machineId: string;
    prompt: unknown;
    projectId?: unknown;
    /** 0013: run inside this (inherited) binding instead of provisioning
     *  its own sandbox — the starting chat's. Project machines only. */
    inherit?: BoundSandbox;
    /** 0021: route overrides for this run (whole-run and per stage). */
    overrides?: unknown;
  },
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
  if (input.inherit && machine.definition.workspace !== "project") {
    throw new MachineError("invalid", `machine ${machine.id} has no workspace to inherit a sandbox into`);
  }
  let overrides: RunOverrides | null = null;
  if (input.overrides != null) {
    const parsed = runOverridesSchema.safeParse(input.overrides);
    if (!parsed.success) {
      throw new MachineError("invalid", `overrides: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    }
    for (const stageId of Object.keys(parsed.data.stages ?? {})) {
      if (!machine.definition.stages[stageId]) {
        throw new MachineError("invalid", `overrides.stages.${stageId}: no such stage in ${machine.id}`);
      }
    }
    overrides = parsed.data.route || parsed.data.stages ? parsed.data : null;
  }
  const id = `mr_${now.toString(36)}${randomUUID().replace(/-/g, "").slice(0, 6)}`;
  const prompt = input.prompt.trim().slice(0, 50_000);
  db.transaction((tx) => {
    tx.insert(machineRuns)
      .values({
        id,
        machineId: machine.id,
        machineName: machine.name,
        machineVersion: machine.version,
        definition: JSON.stringify(machine.definition),
        projectId,
        prompt,
        ...(overrides ? { overrides: JSON.stringify(overrides) } : {}),
        ...(input.inherit
          ? {
              sandboxId: input.inherit.sandboxId,
              sandboxWorkDir: input.inherit.workDir,
              sandboxOwner: false,
            }
          : {}),
        status: "running",
        currentStage: machine.definition.start,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // Seen as of now: the user just started it.
    tx.insert(conversations)
      .values({ id, kind: "run", title: runTitle(prompt), projectId, createdAt: now, updatedAt: now, lastSeenAt: now })
      .run();
  });
  return getRun(db, id);
}

const RUN_TITLE_MAX = 60;

/** A run's conversation title: the prompt's first non-empty line, clipped. */
export function runTitle(prompt: string): string {
  const line = prompt.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  return line.length > RUN_TITLE_MAX ? `${line.slice(0, RUN_TITLE_MAX - 1).trimEnd()}…` : line;
}

/** Statuses where a run stops and wants the user — its "unread" moment. */
export const SETTLED_STATUSES: ReadonlySet<string> = new Set(["waiting", "needs-attention", "completed", "failed"]);
/** Statuses where the run's workflow is still alive (cancel applies). */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["running", "waiting"]);

export function getRun(db: Db, id: string): RunView {
  const row = db.select().from(machineRuns).where(eq(machineRuns.id, id)).get();
  if (!row) throw new MachineError("not-found", `run ${id} not found`);
  return hydrateRun(row);
}

/** 0013: the run's sandbox binding (null for workspace-free runs, or a
 *  project run that has not provisioned yet). */
export function getRunBinding(db: Db, id: string): BoundSandbox | null {
  const row = db
    .select({
      sandboxId: machineRuns.sandboxId,
      workDir: machineRuns.sandboxWorkDir,
      owner: machineRuns.sandboxOwner,
    })
    .from(machineRuns)
    .where(eq(machineRuns.id, id))
    .get();
  if (!row?.sandboxId || !row.workDir) return null;
  return { kind: "bound", sandboxId: row.sandboxId, workDir: row.workDir, owner: !!row.owner };
}

/** Bind a run that provisioned its own sandbox — once; returns the
 *  binding that holds afterwards. */
export function bindRun(db: Db, id: string, binding: BoundSandbox): BoundSandbox {
  db.update(machineRuns)
    .set({ sandboxId: binding.sandboxId, sandboxWorkDir: binding.workDir, sandboxOwner: binding.owner })
    .where(and(eq(machineRuns.id, id), sql`${machineRuns.sandboxId} is null`))
    .run();
  const now = getRunBinding(db, id);
  if (!now) throw new Error(`could not bind run ${id}`);
  return now;
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
  set: Partial<Pick<MachineRun, "status" | "currentStage" | "error" | "workflowRunId">>,
  now = Date.now(),
): void {
  const settled = set.status !== undefined && SETTLED_STATUSES.has(set.status);
  const changed = db
    .update(machineRuns)
    .set({ ...set, ...(settled ? { settledAt: now } : {}), updatedAt: now })
    .where(and(eq(machineRuns.id, id), ne(machineRuns.status, "cancelled")))
    .run().changes;
  // A status change is the run conversation's activity (sidebar order).
  if (changed && set.status !== undefined) {
    db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, id)).run();
  }
}

/**
 * Mark a run cancelled (final). The caller has already stopped its
 * workflow (lib/machines/runs cancelRun). Returns false when the run was
 * not live.
 */
export function markRunCancelled(db: Db, id: string, now = Date.now()): boolean {
  const run = getRun(db, id);
  if (!LIVE_STATUSES.has(run.status)) return false;
  db.update(machineRuns)
    .set({ status: "cancelled", currentStage: null, error: null, updatedAt: now })
    .where(eq(machineRuns.id, id))
    .run();
  db.update(machineStageRuns)
    .set({ status: "parked", error: "run cancelled", endedAt: now })
    .where(and(eq(machineStageRuns.runId, id), inArray(machineStageRuns.status, ["running", "waiting"])))
    .run();
  db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, id)).run();
  return true;
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
  set: Partial<
    Pick<MachineStageRun, "status" | "sessionId" | "outcome" | "transitionTo" | "steps" | "error" | "endedAt" | "route">
  >,
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
