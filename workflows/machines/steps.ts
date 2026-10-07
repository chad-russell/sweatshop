import type { MachineStageRun } from "@/db/schema";
import type { BoundSandbox } from "@/db/sandboxes";
import { machineStore } from "./deps";

/**
 * 0009 machine-run side effects — every function here is a `"use step"`
 * (replay-safe via recorded results); Node/sqlite imports happen inside
 * (through ./deps loaders). The workflow body (run-machine.ts) only
 * orchestrates.
 */

export async function markRun(
  runId: string,
  set: { status?: string; currentStage?: string | null; error?: string | null },
): Promise<void> {
  "use step";
  const { db, m } = await machineStore();
  m.updateRun(db, runId, set);
}

export async function provisionWorkspace(runId: string, projectId: string): Promise<BoundSandbox> {
  "use step";
  const [{ db }, { bindRun, runWorkspaceRoot }, { acquireSandbox }] = await Promise.all([
    import("@/db"),
    import("@/db/machines"),
    import("@/lib/sandboxes/lease"),
  ]);
  // 0013: the run's own sandbox — a dedicated lease at /work/<runId>,
  // bound once (a retried step finds the same lease and binding). It
  // outlives the run; reaping and purge release it.
  const workDir = runWorkspaceRoot(runId);
  const { sandboxId } = await acquireSandbox({
    mode: "dedicated",
    ownerKind: "machine_run",
    ownerId: runId,
    projectId,
    root: workDir,
  });
  return bindRun(db(), runId, { kind: "bound", sandboxId, workDir, owner: true });
}

/** Begin (or, on replay, re-find) a stage visit row. */
export async function beginVisit(input: {
  runId: string;
  seq: number;
  stageId: string;
  kind: string;
  harness?: string | null;
}): Promise<void> {
  "use step";
  const { db, m } = await machineStore();
  const sessionId = input.kind === "harness" ? m.stageSessionId(input.runId, input.seq) : null;
  m.beginStageRun(db, { ...input, sessionId });
  m.updateRun(db, input.runId, {
    currentStage: input.stageId,
    status: input.kind === "human" ? "waiting" : "running",
  });
}

export async function endVisit(input: {
  runId: string;
  seq: number;
  status: "completed" | "failed" | "parked";
  outcome?: string | null;
  transitionTo?: string | null;
  steps?: number;
  error?: string | null;
}): Promise<void> {
  "use step";
  const [{ db }, { updateStageRun }, { clipText }] = await Promise.all([
    import("@/db"),
    import("@/db/machines"),
    import("@/lib/machines/brief"),
  ]);
  updateStageRun(db(), input.runId, input.seq, {
    status: input.status,
    outcome: input.outcome == null ? null : clipText(input.outcome, 50_000),
    transitionTo: input.transitionTo ?? null,
    ...(input.steps !== undefined ? { steps: input.steps } : {}),
    error: input.error == null ? null : clipText(input.error, 2000),
    endedAt: Date.now(),
  });
}

export async function recordSteps(runId: string, seq: number, steps: number): Promise<void> {
  "use step";
  const { db, m } = await machineStore();
  m.updateStageRun(db, runId, seq, { steps });
}

/** Close the harness_runs row the /h view reads. */
export async function endHarnessSession(input: {
  runId: string;
  seq: number;
  harness: "pi" | "claude";
  status: "completed" | "failed";
  error?: string;
}): Promise<void> {
  "use step";
  const [{ recordHarnessEvent, recordHarnessRunEnd, getHarnessRun }, { stageSessionId }] = await Promise.all([
    import("@/lib/harness-events"),
    import("@/db/machines"),
  ]);
  const sessionId = stageSessionId(input.runId, input.seq);
  recordHarnessEvent(sessionId, input.harness, { kind: "end" });
  const run = getHarnessRun(sessionId, input.harness);
  recordHarnessRunEnd(sessionId, input.harness, run?.toolCalls ?? 0, input.status, input.error);
}

/** Earlier visits for the brief (seq < current). */
export async function loadHistory(runId: string): Promise<MachineStageRun[]> {
  "use step";
  const { db, m } = await machineStore();
  return m.listStageRuns(db, runId);
}
