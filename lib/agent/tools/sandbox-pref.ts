import { db } from "@/db";
import { getConversation } from "@/db/chat";
import { acquireSandbox, type AcquireRequest } from "@/lib/sandboxes/lease";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * 0010 Phase 4: resolve the conversation's explicit sandbox choice into
 * an acquire request. The pref is a plain column (docs/0010's
 * "conversation binding" decision): null = the default (dedicated, lazy,
 * project conversations), "attached:<id>" = join that sandbox, "none" =
 * the toolset omits sandboxed tools entirely (handled at build time).
 *
 * Used inside workflow steps only (it reads sqlite).
 */
export async function acquireConversationSandbox(
  conversationId: string,
  projectId: string,
  provider?: SandboxProvider,
): Promise<{ sandboxId: string; handle: ReturnType<SandboxProvider["attach"]> }> {
  const pref = getConversation(db(), conversationId)?.sandboxPref;
  const request: AcquireRequest = pref?.startsWith("attached:")
    ? { mode: "attach", sandboxId: pref.slice("attached:".length), conversationId }
    : {
        mode: "dedicated",
        ownerKind: "conversation",
        ownerId: conversationId,
        projectId,
      };
  return acquireSandbox(request, provider);
}
