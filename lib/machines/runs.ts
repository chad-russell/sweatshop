import { getRun as getWorkflowRun, start } from "workflow/api";
import { db } from "@/db";
import { createRun, getRun, getRunBinding, LIVE_STATUSES, markRunCancelled, updateRun, type RunView } from "@/db/machines";
import type { BoundSandbox } from "@/db/sandboxes";

/**
 * 0012: the one way to start and cancel a machine run (route, the
 * start_machine tool, trash). Server-only: it touches the store and the
 * Workflow SDK runtime.
 */

export async function startRun(input: {
  machineId: string;
  prompt: unknown;
  projectId?: unknown;
  /** 0013: run in this inherited binding (the starting chat's). */
  inherit?: BoundSandbox;
}): Promise<RunView> {
  const run = createRun(db(), input);
  try {
    const { runMachine } = await import("@/workflows/machines/run-machine");
    const workflow = await start(runMachine, [
      {
        runId: run.id,
        definition: run.definition,
        prompt: run.prompt,
        projectId: run.projectId,
        binding: getRunBinding(db(), run.id),
      },
    ]);
    updateRun(db(), run.id, { workflowRunId: workflow.runId });
  } catch (err) {
    updateRun(db(), run.id, { status: "failed", error: `could not start: ${String(err)}` });
    throw err;
  }
  return getRun(db(), run.id);
}

/**
 * Stop a live run: cancel its workflow (when known and present), then
 * mark it cancelled. Runs started before 0012 have no workflow id; they
 * are only marked. A cancelled workflow skips its `finally`, so the
 * run's own sandbox is released here too — never an inherited one
 * (0013: only the owner touches lifecycle).
 */
export async function cancelRun(runId: string, reason = "cancelled by user"): Promise<boolean> {
  const run = getRun(db(), runId);
  if (!LIVE_STATUSES.has(run.status)) return false;
  if (run.workflowRunId) {
    const workflow = getWorkflowRun(run.workflowRunId);
    if (await workflow.exists) await workflow.cancel({ cancelReason: reason });
  }
  const cancelled = markRunCancelled(db(), runId);
  const binding = getRunBinding(db(), runId);
  if (binding?.owner) {
    const { destroySandbox } = await import("@/lib/sandboxes/lease");
    await destroySandbox(binding.sandboxId).catch((err: unknown) => {
      console.error(`[machines] could not release sandbox for cancelled run ${runId}`, err);
    });
  }
  return cancelled;
}
