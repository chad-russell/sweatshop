import { db } from "@/db";
import { getLease, getLeaseByOwner } from "@/db/sandboxes";
import { acquireSandbox } from "@/lib/sandboxes/lease";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * 0010 Phase 3: the attach_sandbox tool's core — the explicit escape
 * hatch from docs/0010. Attaching is always an explicit choice (never
 * automatic): join another conversation's or a machine run's sandbox,
 * getting your own workdir (/work/<conversationId>) while knowingly
 * sharing ports and processes with the owner.
 */

export type AttachTarget =
  | { ownerKind: "conversation" | "machine_run"; ownerId: string }
  | { sandboxId: string };

export async function attachConversationSandbox(
  conversationId: string,
  target: AttachTarget,
  provider?: SandboxProvider,
): Promise<{ sandboxId: string; ref: string; workdir: string }> {
  const lease =
    "sandboxId" in target
      ? getLease(db(), target.sandboxId)
      : getLeaseByOwner(db(), target.ownerKind, target.ownerId);
  if (!lease) {
    throw new Error(
      "sandboxId" in target
        ? `no sandbox ${target.sandboxId}`
        : `no sandbox for ${target.ownerKind} ${target.ownerId}`,
    );
  }
  await acquireSandbox(
    { mode: "attach", sandboxId: lease.id, conversationId },
    provider,
  );
  return { sandboxId: lease.id, ref: lease.ref, workdir: `/work/${conversationId}` };
}
