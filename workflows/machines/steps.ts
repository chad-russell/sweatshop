import type { MachineStageRun } from "@/db/schema";

/**
 * 0009 machine-run side effects — every function here is a `"use step"`
 * (replay-safe via recorded results); Node/sqlite imports happen inside.
 * The workflow body (run-machine.ts) only orchestrates.
 */

export async function markRun(
  runId: string,
  set: { status?: string; currentStage?: string | null; containerName?: string | null; error?: string | null },
): Promise<void> {
  "use step";
  const [{ db }, { updateRun }] = await Promise.all([import("@/db"), import("@/db/machines")]);
  updateRun(db(), runId, set);
}

export async function provisionWorkspace(runId: string, projectId: string): Promise<string> {
  "use step";
  const [{ db }, { updateRun }, { acquireSandbox }] = await Promise.all([
    import("@/db"),
    import("@/db/machines"),
    import("@/lib/sandboxes/lease"),
  ]);
  // 0010 Phase 2: the run's sandbox is a lease — one dedicated sandbox
  // per run through the provider seam, destroyed with the run (0009
  // semantics: one container for the whole run, removed at the end).
  // A failed create cleans up after itself inside the lease layer.
  const { handle } = await acquireSandbox({
    mode: "dedicated",
    ownerKind: "machine_run",
    ownerId: runId,
    projectId,
  });
  updateRun(db(), runId, { containerName: handle.ref });
  return handle.ref;
}

export async function removeWorkspace(runId: string): Promise<void> {
  "use step";
  const [{ db }, { getLeaseByOwner }] = await Promise.all([
    import("@/db"),
    import("@/db/sandboxes"),
  ]);
  const lease = getLeaseByOwner(db(), "machine_run", runId);
  if (!lease) return;
  const { destroySandbox } = await import("@/lib/sandboxes/lease");
  await destroySandbox(lease.id);
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
  const [{ db }, m] = await Promise.all([import("@/db"), import("@/db/machines")]);
  const sessionId = input.kind === "harness" ? m.stageSessionId(input.runId, input.seq) : null;
  m.beginStageRun(db(), { ...input, sessionId });
  m.updateRun(db(), input.runId, {
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
  const [{ db }, { updateStageRun }] = await Promise.all([import("@/db"), import("@/db/machines")]);
  updateStageRun(db(), runId, seq, { steps });
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
  const [{ db }, { listStageRuns }] = await Promise.all([import("@/db"), import("@/db/machines")]);
  return listStageRuns(db(), runId);
}

/**
 * Start an eve stage: create an unsandboxed eve session whose first
 * message is the brief. The machine-visit header becomes a principal
 * attribute (agent/channels/eve.ts) that scopes the `transition` tool
 * to this session and points it at the visit's hook. `operationId`
 * keeps a retried step from starting a second session.
 */
export async function startEveStage(input: {
  runId: string;
  seq: number;
  token: string;
  brief: string;
  model?: string;
}): Promise<string> {
  "use step";
  const [{ db }, { updateStageRun }] = await Promise.all([import("@/db"), import("@/db/machines")]);
  const origin = process.env.SWEATSHOP_INTERNAL_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const res = await fetch(`${origin}/eve/v1/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sweatshop-machine-visit": input.token,
      ...(input.model ? { "x-sweatshop-model": input.model } : {}),
    },
    body: JSON.stringify({ message: input.brief, operationId: `machine-${input.token}` }),
  });
  if (!res.ok) throw new Error(`eve session create failed: HTTP ${res.status} ${await res.text()}`);
  const { sessionId } = (await res.json()) as { sessionId: string };
  updateStageRun(db(), input.runId, input.seq, { sessionId, status: "running" });
  return sessionId;
}

/** Final assistant text of an eve stage's conversation (from the mirror). */
export async function eveStageOutcome(sessionId: string): Promise<string> {
  "use step";
  const [{ db }, { messages }, { and, desc, eq }] = await Promise.all([
    import("@/db"),
    import("@/db/schema"),
    import("drizzle-orm"),
  ]);
  const rows = db()
    .select({ text: messages.text })
    .from(messages)
    .where(and(eq(messages.conversationId, sessionId), eq(messages.role, "assistant")))
    .orderBy(desc(messages.at))
    .limit(3)
    .all();
  return rows.reverse().map((r) => r.text).join("\n\n");
}
