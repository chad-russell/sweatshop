import { db } from "@/db";
import { getConversation } from "@/db/chat";
import { recordSandboxCall } from "@/db/sandboxes";
import { acquireSandbox, type AcquireRequest } from "@/lib/sandboxes/lease";
import { sandboxWorkRoot } from "@/lib/sandboxes/provision";
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
/** 0011: identifies the tool call to attribute to the sandbox it lands in. */
export interface CallAttribution {
  toolCallId: string;
  tool: "bash" | "pi" | "claude";
}

export async function acquireConversationSandbox(
  conversationId: string,
  projectId: string | null,
  provider?: SandboxProvider,
  attribution?: CallAttribution,
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
  const acquired = await acquireSandbox(request, provider);
  // 0011: record where the call ACTUALLY ran (not what the pref said
  // when the message was sent), once the sandbox is in hand.
  if (attribution) {
    recordSandboxCall(db(), {
      toolCallId: attribution.toolCallId,
      sandboxId: acquired.sandboxId,
      conversationId,
      tool: attribution.tool,
      via: request.mode === "attach" ? "attached" : "dedicated",
      workdir: sandboxWorkRoot(conversationId),
    });
  }
  return acquired;
}
