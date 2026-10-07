import { start } from "workflow/api";
import { db } from "@/db";
import { getConversation, setActiveRun } from "@/db/chat";
import { getConversationBinding } from "@/db/sandboxes";
import type { ViewingContext } from "@/lib/page-context";
import { chatTurn } from "@/workflows/chat/turn";

/** Statuses a queued steer message can still land inside. */
export const ACTIVE_RUN_STATUSES = new Set(["pending", "running"]);

/**
 * Start one chat turn workflow for an existing conversation (the chat
 * route's send path, and 0016's server-started "Fix it" chats). The
 * caller has already checked no turn is live.
 */
export async function startChatTurn(
  conversationId: string,
  text: string,
  viewing?: ViewingContext,
): Promise<{ runId: string }> {
  const conversation = getConversation(db(), conversationId);
  if (!conversation) throw new Error(`no conversation ${conversationId}`);
  const run = await start(chatTurn, [
    {
      conversationId,
      userText: text,
      hasSandbox: getConversationBinding(db(), conversationId)?.kind !== "none",
      hasProject: !!conversation.projectId,
      ...(viewing ? { viewing } : {}),
    },
  ]);
  // The run may complete before this write lands (fast turns); the next
  // send sweeps a stale row via its status check.
  if (ACTIVE_RUN_STATUSES.has(await run.status)) setActiveRun(db(), conversationId, run.runId);
  return { runId: run.runId };
}
