import type { StoredRow } from "./chat-ui";

/**
 * 0075 client fetchers for the lazily-loaded transcript: one tail page
 * of `GET /api/x/chat` plus the shared "extend backwards" loop. Pure
 * client-side helpers — no db imports (components may import this file
 * freely).
 */

/** One paged fetch of `GET /api/x/chat`. */
export interface ChatPage {
  rows: StoredRow[];
  activeRunId: string | null;
  /** rowid of `rows[0]` when older rows remain; null = start reached. */
  olderCursor: number | null;
  olderRemaining: number;
}

/** Fetch one page; null on any failure (callers keep their window). */
export async function fetchChatPage(
  conversationId: string,
  opts: { tail: number; before?: number },
): Promise<ChatPage | null> {
  const params = new URLSearchParams({ conversationId, tail: String(opts.tail) });
  if (opts.before != null) params.set("before", String(opts.before));
  try {
    const res = await fetch(`/api/x/chat?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) return null;
    // The route serializes the page's rows under its long-standing
    // `messages` key.
    const body = (await res.json()) as Partial<ChatPage> & { messages?: StoredRow[] };
    return {
      rows: body.messages ?? body.rows ?? [],
      activeRunId: body.activeRunId ?? null,
      olderCursor: body.olderCursor ?? null,
      olderRemaining: body.olderRemaining ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Grow a page backwards until `done(rows)` holds over the combined,
 * oldest-first rows (or the conversation's start). Used to walk back to
 * a turn boundary — the live turn's opening `t_` row on hydration, or
 * the oldest `t_`/known row a wake poll needs for an aligned append.
 * Returns the extended page (the input when nothing more is needed);
 * the caller folds and merges.
 */
export async function extendChatPageBack(
  conversationId: string,
  page: ChatPage,
  tail: number,
  done: (rows: StoredRow[]) => boolean,
): Promise<ChatPage> {
  let current = page;
  while (!done(current.rows) && current.olderCursor != null) {
    const older = await fetchChatPage(conversationId, { tail, before: current.olderCursor });
    if (!older) break; // transient failure — keep what we have
    current = {
      rows: [...older.rows, ...current.rows],
      activeRunId: current.activeRunId,
      olderCursor: older.olderCursor,
      olderRemaining: older.olderRemaining,
    };
  }
  return current;
}
