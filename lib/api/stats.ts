/**
 * 0047: a conversation's metered usage breakdown (the composer's usage
 * ring + popover). Null on any failure, network included — the
 * popover's error state is what Retry re-fires.
 */

import type { ConversationStats } from "@/lib/usage/stats";
import { apiFetch } from "./core";

/** The conversation's stats payload. Never throws. */
export async function getConversationStats(conversationId: string): Promise<ConversationStats | null> {
  try {
    const res = await apiFetch<ConversationStats>(`/api/x/stats/${encodeURIComponent(conversationId)}`);
    return res.ok ? res.body : null;
  } catch {
    return null;
  }
}
