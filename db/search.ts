import { sql } from "drizzle-orm";
import type { Db } from "./index";

export interface SearchHit {
  conversationId: string;
  title: string | null;
  snippet: string;
  hits: number;
}

/**
 * Phrase-quote user input so FTS5 query syntax cannot be injected:
 * everything becomes one literal phrase, inner quotes doubled.
 */
export function toFtsPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

/**
 * Search conversation text (0003): FTS5 match over `messages`, grouped to
 * one hit per conversation in TypeScript — snippet() is an FTS5 auxiliary
 * function and only works on a concrete matched row, so the SQL stays
 * flat (per-row matches, bm25-ordered) and the grouping happens here.
 */
export function searchConversations(
  db: Db,
  query: string,
  limit = 20,
): SearchHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const rows = db.all<{
    conversationId: string;
    title: string | null;
    snippet: string;
    at: number;
  }>(sql`
    select m.conversation_id as conversationId,
           c.title as title,
           snippet(messages_fts, 0, '[', ']', '…', 12) as snippet,
           m.at as at
    from messages_fts
    join messages m on m.rowid = messages_fts.rowid
    join conversations c on c.id = m.conversation_id
    where messages_fts match ${toFtsPhrase(trimmed)}
    order by bm25(messages_fts), m.at desc
    limit 100
  `);

  const byConversation = new Map<string, SearchHit>();
  for (const row of rows) {
    const existing = byConversation.get(row.conversationId);
    if (existing) {
      existing.hits += 1;
      continue;
    }
    // rows arrive bm25-ordered, so the first row per conversation carries
    // the best snippet; stop admitting new conversations at the limit but
    // keep counting hits for admitted ones.
    if (byConversation.size >= limit) continue;
    byConversation.set(row.conversationId, {
      conversationId: row.conversationId,
      title: row.title,
      snippet: row.snippet,
      hits: 1,
    });
  }

  return [...byConversation.values()];
}
