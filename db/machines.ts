import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./index";
import type { BoundSandbox } from "./sandboxes";
import { machineRuns, machineStageRuns } from "./schema";
import type { MachineRun, MachineStageRun } from "./schema";

/**
 * 0009 machines, READ-ONLY since 0037 phase 5 deleted the interpreter,
 * the tools, and the write paths. Rows stay as history — runs were
 * conversations (0012), so they remain in the sidebar, searchable,
 * trashable, and rendered by the static /r/<id> view until purged.
 * Readers: /r, the run GET API, child-status (historical cards),
 * attention (unread runs), inspect.
 */

export type MachineErrorCode = "not-found";

export class MachineError extends Error {
  constructor(readonly code: MachineErrorCode, message: string) {
    super(message);
  }
}

export interface RunView extends Omit<MachineRun, "definition" | "overrides"> {
  /** Stage ids in definition order (parse the definition JSON for more). */
  stageIds: string[];
  startStage: string | null;
}

export function hydrateRunReadonly(row: MachineRun): RunView {
  let definition: { start?: string; stages?: Record<string, unknown> } = {};
  try {
    definition = JSON.parse(row.definition) as typeof definition;
  } catch {
    /* a malformed snapshot still renders */
  }
  const { definition: _def, overrides: _ovr, ...rest } = row;
  void _def; void _ovr;
  return {
    ...rest,
    stageIds: Object.keys(definition.stages ?? {}),
    startStage: definition.start ?? null,
  };
}

export function getRun(db: Db, id: string): RunView {
  const row = db.select().from(machineRuns).where(eq(machineRuns.id, id)).get();
  if (!row) throw new MachineError("not-found", `no machine run ${id}`);
  return hydrateRunReadonly(row);
}

export function listStageRuns(db: Db, runId: string): MachineStageRun[] {
  return db
    .select()
    .from(machineStageRuns)
    .where(eq(machineStageRuns.runId, runId))
    .orderBy(asc(machineStageRuns.seq))
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

export function stageSessionId(runId: string, seq: number): string {
  return `${runId}_${seq}`;
}

/** Historical statuses a run could be live in (child-status, reaper). */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["running", "waiting"]);

/** A historical run's sandbox binding (inspect; 0013 columns). */
export function getRunBinding(db: Db, id: string): BoundSandbox | null {
  const row = db
    .select({
      sandboxId: machineRuns.sandboxId,
      sandboxWorkDir: machineRuns.sandboxWorkDir,
      sandboxOwner: machineRuns.sandboxOwner,
    })
    .from(machineRuns)
    .where(eq(machineRuns.id, id))
    .get();
  if (!row?.sandboxId || !row.sandboxWorkDir) return null;
  return { kind: "bound", sandboxId: row.sandboxId, workDir: row.sandboxWorkDir, owner: !!row.sandboxOwner };
}
