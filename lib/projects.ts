import { db } from "@/db";
import {
  deleteProjectRows,
  listLiveProjectRuns,
  listLiveProjectSandboxes,
  type DeleteProjectCounts,
  type ProjectResult,
} from "@/db/projects";
import { destroySandbox } from "@/lib/sandboxes/lease";
import { cancelRun } from "@/lib/machines/runs";
import { sandboxProvider, type SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * 0018 phase 3: the delete-project orchestrator — the substrate half
 * (cancel live runs, destroy live sandboxes with their services)
 * before the store's transactional row deletes. Individual
 * cancellations/destroys never abort the delete: a live container
 * whose rows vanish is cleaned up by podman's own lifecycle, and the
 * delete is idempotent to re-run.
 */
export async function deleteProjectFully(
  projectId: string,
  provider?: SandboxProvider,
): Promise<ProjectResult<{ counts: DeleteProjectCounts }>> {
  const p = provider ?? sandboxProvider();
  for (const runId of listLiveProjectRuns(db(), projectId)) {
    await cancelRun(runId, "project deleted").catch(() => undefined);
  }
  for (const sandboxId of listLiveProjectSandboxes(db(), projectId)) {
    await destroySandbox(sandboxId, p).catch(() => undefined);
  }
  return deleteProjectRows(db(), projectId);
}
