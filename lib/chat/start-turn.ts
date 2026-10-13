import { start } from "workflow/api";
import { db } from "@/db";
import {
  getConversation,
  resolveOrphanedPendingInputs,
  setActiveRun,
  type RunEventMeta,
} from "@/db/chat";
import { getConversationBinding } from "@/db/sandboxes";
import type { ViewingContext } from "@/lib/page-context";
import { chatTurn } from "@/workflows/chat/turn";

/** Statuses a queued steer message can still land inside. */
export const ACTIVE_RUN_STATUSES = new Set(["pending", "running"]);

/**
 * Start one chat turn workflow for an existing conversation (the chat
 * route's send path, 0016's server-started "Fix it" chats, and 0022's
 * wake). The caller has already checked no turn is live.
 *
 * A non-plan pending input is answerable only while its run is live,
 * so starting a turn means every leftover card is an orphan of a dead
 * run — resolve them (2026-10-13: cancelled runs left inbox approvals
 * that no button could clear).
 */
export async function startChatTurn(
  conversationId: string,
  text: string,
  viewing?: ViewingContext,
  /** 0022: marks the row as a wake message (transcript chip). */
  runEvent?: RunEventMeta,
): Promise<{ runId: string }> {
  const conversation = getConversation(db(), conversationId);
  if (!conversation) throw new Error(`no conversation ${conversationId}`);
  resolveOrphanedPendingInputs(db(), conversationId, "run-ended");
  const run = await start(chatTurn, [
    {
      conversationId,
      userText: text,
      hasSandbox: getConversationBinding(db(), conversationId)?.kind !== "none",
      hasProject: !!conversation.projectId,
      ...(viewing ? { viewing } : {}),
      ...(runEvent ? { runEvent } : {}),
    },
  ]);
  // The run may complete before this write lands (fast turns); the next
  // send sweeps a stale row via its status check.
  if (ACTIVE_RUN_STATUSES.has(await run.status)) setActiveRun(db(), conversationId, run.runId);
  return { runId: run.runId };
}
