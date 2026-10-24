/**
 * Conversation row mutations the composer/inbox drive from the client:
 * seen flags (single debounced + the inbox's mark-all), the composer's
 * host-auto-approve PATCH, and the sandbox panel's view read.
 */

import type { ConversationSandboxViewData } from "@/components/sandbox-view";
import { apiFetch, jsonInit, type ApiResult } from "./core";

/**
 * Set a thread's seen flag. Returns the row's `{changed}` (null on any
 * HTTP failure) — use-mark-seen refreshes only when the server says
 * the flag actually moved; the inbox just fires and refreshes. Network
 * errors reject, exactly as they did at both call sites.
 */
export async function markConversationSeen(conversationId: string, seen: boolean): Promise<{ changed: boolean } | null> {
  const res = await apiFetch<{ changed?: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/seen`,
    jsonInit("PUT", { seen }),
  );
  return res.ok ? { changed: res.body?.changed === true } : null;
}

/** The inbox's mark-all-read button: settle every unread thread.
 * Network errors reject (the inbox does not catch them today). */
export async function markAllInboxRead(): Promise<void> {
  await apiFetch("/api/inbox/mark-all-read", jsonInit("POST"));
}

/**
 * PATCH a conversation row (the composer's host-auto-approve toggle,
 * the sidebar's move/rename/archive/trash). Returns the raw result —
 * callers that need the status (the composer throws on !ok to revert)
 * get it, the sidebar reads the error body.
 */
export async function updateConversation(conversationId: string, patch: Record<string, unknown>): Promise<ApiResult> {
  return apiFetch(`/api/conversations/${encodeURIComponent(conversationId)}`, jsonInit("PATCH", patch));
}

/** Delete a trashed conversation forever (the sidebar's last step). */
export async function deleteConversation(conversationId: string): Promise<ApiResult> {
  return apiFetch(`/api/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
}

/**
 * The sandbox panel's read-model (0049). Null on any failure, network
 * included — the effect that polls it keeps the last good view.
 */
export async function getConversationSandbox(conversationId: string): Promise<ConversationSandboxViewData | null> {
  try {
    const res = await apiFetch<ConversationSandboxViewData>(
      `/api/conversations/${encodeURIComponent(conversationId)}/sandbox`,
      { cache: "no-store" },
    );
    return res.ok ? res.body : null;
  } catch {
    return null;
  }
}
