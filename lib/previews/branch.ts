import { db } from "@/db";
import { getPreview } from "@/db/previews";
import { getLease } from "@/db/sandboxes";
import { destroySandbox } from "@/lib/sandboxes/lease";
import { deletePreview, type PreviewDeps } from "@/lib/previews/service";

/**
 * 0016: deleting a preview. A worktree preview only stops — its sandbox
 * belongs to the chat or run. A preview-owned sandbox (branch previews)
 * exists only to serve it, so it is destroyed with it.
 */
export async function removePreview(id: string, deps: PreviewDeps = {}): Promise<void> {
  const p = getPreview(db(), id);
  if (!p) return;
  await deletePreview(id, deps);
  const lease = getLease(db(), p.sandboxId);
  if (lease?.ownerKind === "preview" && lease.status !== "destroyed") {
    await destroySandbox(lease.id, deps.provider);
  }
}
