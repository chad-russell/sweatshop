import { and, eq } from "drizzle-orm";
import { harnessEvents, type MachineStageRun } from "@/db/schema";
import type { BoundSandbox } from "@/db/sandboxes";
import { machineStore } from "./deps";

/**
 * 0009 machine-run side effects — every function here is a `"use step"`
 * (replay-safe via recorded results); Node/sqlite imports happen inside
 * (through ./deps loaders). The workflow body (run-machine.ts) only
 * orchestrates.
 */

/**
 * 0034 A: the deterministic publish stage — push the run's approved PR
 * proposal and open it. One step, no model; the human gate upstream was
 * the approval, so this executes exactly what that gate's card showed
 * (the proposal row is immutable between the two). A protected head or
 * a failed push/open parks the run with the reason.
 */
export async function publishStep(input: {
  runId: string;
  binding: BoundSandbox;
}): Promise<{ ok: true; outcome: string; proposed: null } | { ok: false; parked: string }> {
  "use step";
  const [{ db }, store, { openProjectPR }, { openSandbox }, { isProtectedRef, isSafeRefName }] =
    await Promise.all([
      import("@/db"),
      import("@/db/pr-proposals"),
      import("@/lib/git-hosts/open-pr"),
      import("@/lib/sandboxes/binding"),
      import("@/lib/git-hosts/refs"),
    ]);
  const proposal = store.pendingRunProposal(db(), input.runId);
  if (!proposal) {
    return {
      ok: false,
      parked: "publish stage reached with no pending PR proposal — a prior stage must call propose_pr",
    };
  }
  if (!isSafeRefName(proposal.head)) {
    return { ok: false, parked: `proposal head "${proposal.head}" is not a safe ref name` };
  }
  // The hard deny list always applies; the checkout's default branch is
  // checked with the push below (it needs the sandbox).
  if (isProtectedRef(proposal.head)) {
    store.resolvePRProposal(db(), proposal.id, {
      status: "failed",
      error: `refused to push protected branch "${proposal.head}"`,
    });
    return {
      ok: false,
      parked: `publish refused: "${proposal.head}" is a protected branch (0034)`,
    };
  }

  // Tests (double-gated, like the harness mocks): skip the sandbox push.
  if (!(process.env.SWEATSHOP_PUBLISH_MOCK && process.env.NODE_ENV === "test")) {
    const { workDir, handle } = await openSandbox(input.binding);
    let defaultBranch: string | null = null;
    const head = await handle.run(
      "git symbolic-ref --short refs/remotes/origin/HEAD",
      undefined,
      workDir,
    );
    if (head.exitCode === 0) {
      defaultBranch = head.stdout.trim().replace(/^origin\//, "") || null;
    }
    if (isProtectedRef(proposal.head, defaultBranch)) {
      store.resolvePRProposal(db(), proposal.id, {
        status: "failed",
        error: `refused to push protected branch "${proposal.head}"`,
      });
      return {
        ok: false,
        parked: `publish refused: "${proposal.head}" is a protected branch (0034)`,
      };
    }
    const push = await handle.run(`git push origin ${proposal.head}`, undefined, workDir);
    if (push.exitCode !== 0) {
      const why = push.stderr.trim().split("\n")[0] ?? "git error";
      store.resolvePRProposal(db(), proposal.id, { status: "failed", error: `push failed: ${why}` });
      return { ok: false, parked: `pushing ${proposal.head} failed: ${why}` };
    }
  }

  try {
    const pr = await openProjectPR({
      projectId: proposal.projectId,
      repo: proposal.repo,
      head: proposal.head,
      base: proposal.base ?? undefined,
      title: proposal.title,
      body: proposal.body ?? undefined,
    });
    store.resolvePRProposal(db(), proposal.id, { status: "opened", url: pr.url, number: pr.number });
    return { ok: true, outcome: `[pr] opened #${pr.number}: ${pr.url}`, proposed: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    store.resolvePRProposal(db(), proposal.id, { status: "failed", error });
    return { ok: false, parked: `branch pushed but the PR could not be opened: ${error}` };
  }
}

export async function markRun(
  runId: string,
  set: { status?: string; currentStage?: string | null; error?: string | null },
): Promise<void> {
  "use step";
  const { db, m } = await machineStore();
  m.updateRun(db, runId, set);
  // 0022: a settle (completed/failed/needs-attention here) wakes the
  // chat that started the run, once per settle.
  await maybeWake(runId);
}

/**
 * 0022: deliver this run's latest settle to its parent chat, if due.
 * Shared by markRun, beginVisit's waiting write, and the tick sweep —
 * always AFTER the status write, and stamping `woken_settled_at` only
 * once the message is on its way (a crash in between duplicates at
 * worst; the sweep re-fires).
 */
async function maybeWake(runId: string): Promise<void> {
  const [dbMod, m, { wakeRunIfDue }] = await Promise.all([
    import("@/db"),
    import("@/db/machines"),
    import("@/lib/chat/wake"),
  ]);
  try {
    await wakeRunIfDue(m.getRun(dbMod.db(), runId));
  } catch (err) {
    // A wake failure must never fail the run's own step — the sweep
    // retries, and the settle itself already happened.
    console.error(`[wake] ${runId}:`, err);
  }
}

export async function provisionWorkspace(runId: string, projectId: string): Promise<BoundSandbox> {  "use step";
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
  // 0022: a human gate settles the run into `waiting` — wake the parent.
  if (input.kind === "human") await maybeWake(input.runId);
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
  const [{ recordHarnessEvent, recordHarnessRunEnd, countToolCalls }, { stageSessionId }] = await Promise.all([
    import("@/lib/harness-events"),
    import("@/db/machines"),
  ]);
  const sessionId = stageSessionId(input.runId, input.seq);
  recordHarnessEvent(sessionId, input.harness, { kind: "end" });
  // 2026-10-09 friction: re-reading the row just returns the zero the
  // claim wrote — count the session's own tool-start events instead.
  recordHarnessRunEnd(sessionId, input.harness, countToolCalls(sessionId, input.harness), input.status, input.error);
}

/** Earlier visits for the brief (seq < current). */
export async function loadHistory(runId: string): Promise<MachineStageRun[]> {
  "use step";
  const { db, m } = await machineStore();
  return m.listStageRuns(db, runId);
}

/**
 * 2026-10-09 post-mortem: the attachments each prior harness visit
 * produced (attach_screenshot tool results), keyed by seq — evidence
 * the next stage reviews instead of re-deriving the work.
 */
export async function loadEvidence(
  runId: string,
): Promise<Record<number, { label?: string; url: string }[]>> {
  "use step";
  const { collectRunEvidence } = await import("@/lib/machines/evidence");
  return collectRunEvidence(runId);
}

/**
 * 0021: resolve and validate a visit's route (run-stage override > run
 * override > stage > project > global; claude never inherits a chat or
 * project route) and record it — with the layer it came from — on the
 * visit row. A step because it reads sqlite and env; deterministic
 * failures (missing key, project restriction) are FatalErrors.
 */
export async function resolveVisitRoute(input: {
  runId: string;
  seq: number;
  stageId: string;
  surface: "agent" | "pi" | "claude";
}): Promise<{
  route: import("@/lib/providers/route").Route;
  layer: import("@/lib/providers/route").RouteLayer;
}> {
  "use step";
  const [{ db }, m, { requireRoute }] = await Promise.all([
    import("@/db"),
    import("@/db/machines"),
    import("@/lib/providers/resolve"),
  ]);
  const run = m.getRun(db(), input.runId);
  const stage = run.definition.stages[input.stageId];
  const stageRoute = stage && "route" in stage ? (stage.route ?? null) : null;
  const resolved = requireRoute(
    db(),
    input.surface,
    {
      runStage: run.overrides?.stages?.[input.stageId] ?? null,
      run: run.overrides?.route ?? null,
      stage: stageRoute,
    },
    run.projectId,
  );
  m.recordStageRoute(db(), input.runId, input.seq, resolved);
  return resolved;
}
