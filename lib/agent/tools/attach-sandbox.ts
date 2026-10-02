import { db } from "@/db";
import { updateConversationSettings } from "@/db/chat";
import { getLease, getLeaseByOwner } from "@/db/sandboxes";
import { acquireSandbox } from "@/lib/sandboxes/lease";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * 0010 Phase 3: the attach_sandbox tool's core — the explicit escape
 * hatch from docs/0010. Attaching is always an explicit choice (never
 * automatic): join another conversation's or a machine run's sandbox,
 * getting your own workdir (/work/<conversationId>) while knowingly
 * sharing ports and processes with the owner. A successful attach also
 * sets the conversation's sandbox pref (0011), so it actually takes effect.
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
  if (!lease || lease.status === "destroyed") {
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
  // 0011: attaching means something — the conversation's sandbox choice
  // becomes this sandbox, so its next bash/pi/claude call lands here.
  updateConversationSettings(db(), conversationId, { sandboxPref: `attached:${lease.id}` });
  return { sandboxId: lease.id, ref: lease.ref, workdir: `/work/${conversationId}` };
}
