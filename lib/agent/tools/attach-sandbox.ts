import { db } from "@/db";
import { getLease, getLeaseByOwner } from "@/db/sandboxes";
import { attachConversation } from "@/lib/sandboxes/binding";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * 0013: attach a fresh conversation to an existing sandbox (another
 * conversation's or a machine run's) by copying its binding — same
 * sandbox, same working directory, so you land in the actual work.
 * Attaching is the start-of-conversation choice: once a conversation is
 * bound (attached, or its own sandbox created on first use) it never
 * changes; switching sandboxes means starting a new chat.
 */

export type AttachTarget =
  | { ownerKind: "conversation"; ownerId: string }
  | { sandboxId: string };

export async function attachConversationSandbox(
  conversationId: string,
  target: AttachTarget,
  provider?: SandboxProvider,
): Promise<{ sandboxId: string; workdir: string }> {
  const lease =
    "sandboxId" in target
      ? getLease(db(), target.sandboxId)
      : getLeaseByOwner(db(), target.ownerKind, target.ownerId);
  if (!lease || lease.status === "destroyed") {
    throw new Error(
      "sandboxId" in target
        ? `no sandbox ${target.sandboxId}`
        : `no sandbox for ${target.ownerKind} ${target.ownerId}`,
    );
  }
  const bound = await attachConversation(conversationId, lease.id, provider);
  return { sandboxId: bound.sandboxId, workdir: bound.workDir };
}
