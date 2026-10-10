import { db } from "@/db";
import {
  deleteProjectRows,
  listLiveProjectSandboxes,
  type DeleteProjectCounts,
  type ProjectResult,
} from "@/db/projects";
import { destroySandbox } from "@/lib/sandboxes/lease";
import { sandboxProvider, type SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * 0018 phase 3: the delete-project orchestrator — the substrate half
 * (destroy live sandboxes with their services) before the store's
 * transactional row deletes. (It also cancelled live machine runs;
 * 0037 phase 5 deleted machines — no run can be live anymore.)
 * Individual destroys never abort the delete: a live container whose
 * rows vanish is cleaned up by podman's own lifecycle, and the delete
 * is idempotent to re-run.
 */
export async function deleteProjectFully(
  projectId: string,
  provider?: SandboxProvider,
): Promise<ProjectResult<{ counts: DeleteProjectCounts }>> {
  const p = provider ?? sandboxProvider();
  for (const sandboxId of listLiveProjectSandboxes(db(), projectId)) {
    await destroySandbox(sandboxId, p).catch(() => undefined);
  }
  return deleteProjectRows(db(), projectId);
}
