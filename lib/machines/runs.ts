import { getRun as getWorkflowRun, start } from "workflow/api";
import { db } from "@/db";
import {
  createRun,
  getRun,
  getRunBinding,
  LIVE_STATUSES,
  MachineError,
  markRunCancelled,
  updateRun,
  type RunView,
} from "@/db/machines";
import { getProject } from "@/db/projects";
import { getProjectModels } from "@/db/providers";
import { validationContext } from "@/lib/providers/resolve";
import { validateRoute } from "@/lib/providers/route";
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
  /** 0021: route overrides — `{ route?, stages?: { [stageId]: route } }`. */
  overrides?: unknown;
  /** 0022: the chat that started this run — woken when it settles. */
  parentConversationId?: unknown;
}): Promise<RunView> {
  const run = createRun(db(), input);
  // 0021: an override that cannot run (missing key, forbidden by the
  // project) is rejected at start, not discovered mid-run.
  const issues = overrideIssues(run);
  if (issues.length > 0) {
    updateRun(db(), run.id, { status: "failed", error: `invalid overrides: ${issues.join("; ")}` });
    throw new MachineError("invalid", `overrides: ${issues.join("; ")}`);
  }
  try {
    const { runMachine } = await import("@/workflows/machines/run-machine");
    // 0023: the project's work defaults ride the workflow input as
    // plain data (read here, before the run starts — the body stays
    // Node-free) and land in every stage brief's "# Project" section.
    const project = run.projectId ? getProject(db(), run.projectId) : null;
    const workflow = await start(runMachine, [
      {
        runId: run.id,
        definition: run.definition,
        prompt: run.prompt,
        projectId: run.projectId,
        binding: getRunBinding(db(), run.id),
        project: project
          ? { testCommand: project.testCommand ?? null, branchPrefix: project.branchPrefix ?? null }
          : null,
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
 * are only marked. 0013: the sandbox is left alone — a cancelled run's
 * work stays inspectable like a finished one's; the run windows of
 * sandbox-gc (or purging the run) release an owned sandbox.
 */
export async function cancelRun(runId: string, reason = "cancelled by user"): Promise<boolean> {
  const run = getRun(db(), runId);
  if (!LIVE_STATUSES.has(run.status)) return false;
  if (run.workflowRunId) {
    const workflow = getWorkflowRun(run.workflowRunId);
    if (await workflow.exists) await workflow.cancel({ cancelReason: reason });
  }
  return markRunCancelled(db(), runId);
}

/** 0021: every route a run's overrides name, checked against its project. */
function overrideIssues(run: RunView): string[] {
  if (!run.overrides) return [];
  const ctx = validationContext(db(), getProjectModels(db(), run.projectId));
  const issues: string[] = [];
  const check = (where: string, route: Parameters<typeof validateRoute>[0]) => {
    const r = validateRoute(route, ctx);
    if (!r.ok) issues.push(...r.issues.map((i) => `${where}: ${i}`));
  };
  if (run.overrides.route) check("route", run.overrides.route);
  for (const [stageId, route] of Object.entries(run.overrides.stages ?? {})) {
    const stage = run.definition.stages[stageId];
    if (stage?.kind === "human") issues.push(`stages.${stageId}: human stages have no route`);
    else if (stage?.kind === "harness" && !("harness" in route && route.harness === stage.harness)) {
      issues.push(`stages.${stageId}: a ${stage.harness} stage needs a { harness: "${stage.harness}", … } route`);
    } else if (stage?.kind === "agent" && "harness" in route) {
      issues.push(`stages.${stageId}: an agent stage takes { provider, model }`);
    } else check(`stages.${stageId}`, route);
  }
  return issues;
}
