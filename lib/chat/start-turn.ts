import { start } from "workflow/api";
import { db } from "@/db";
import {
  getConversation,
  resolveOrphanedPendingInputs,
  setActiveRun,
  type RunEventMeta,
} from "@/db/chat";
import { getConversationBinding } from "@/db/sandboxes";
import { listProjectHosts } from "@/db/hosts";
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
  /** 0042: uploaded image ids riding this send. */
  attachments?: string[],
): Promise<{ runId: string }> {
  const conversation = getConversation(db(), conversationId);
  if (!conversation) throw new Error(`no conversation ${conversationId}`);
  resolveOrphanedPendingInputs(db(), conversationId, "run-ended");
  // 0047 review fix (price cold-start): fire-and-forget price warm — the
  // models JSON API used to be the only lazy fetcher, so a fresh deploy's
  // first turns metered null-cost forever (cost-at-capture never
  // backfills). Never awaited, never throws: a slow fetch costs nothing,
  // a failed one keeps whatever rows exist.
  import("../usage/prices-refresh").then(({ ensureModelPrices }) =>
    ensureModelPrices(db()).catch(() => {}),
  );
  const run = await start(chatTurn, [
    {
      conversationId,
      userText: text,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      hasSandbox: getConversationBinding(db(), conversationId)?.kind !== "none",
      hasProject: !!conversation.projectId,
      // 0040 phase 3: a start_thread child gets the thread step budget
      // even with no skill bound.
      hasParent: !!conversation.parentConversationId,
      // 0043: the host allow-list rides the input (empty for no hosts).
      ...(conversation.projectId
        ? {
            hosts: listProjectHosts(db(), conversation.projectId).map((h) => ({
              name: h.name,
              address: h.address,
              user: h.user,
              apiBase: h.apiBase,
            })),
          }
        : {}),
      ...(viewing ? { viewing } : {}),
      ...(runEvent ? { runEvent } : {}),
    },
  ]);
  // The run may complete before this write lands (fast turns); the next
  // send sweeps a stale row via its status check.
  if (ACTIVE_RUN_STATUSES.has(await run.status)) setActiveRun(db(), conversationId, run.runId);
  return { runId: run.runId };
}
