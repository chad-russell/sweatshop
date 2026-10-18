import { sql, type SQL } from "drizzle-orm";
import type { Db } from "./index";
import { folderPath, folderSubtreeIds } from "./organize";
import { conversations, folders, projects } from "./schema";
import type { SearchHit, SearchOptions } from "../lib/read-models/search";

// 0049: the view shapes moved to @/lib/read-models/search; re-exported
// here so server-side importers keep one door into the store layer.
export type { SearchHit, SearchOptions } from "../lib/read-models/search";

/**
 * Phrase-quote user input so FTS5 query syntax cannot be injected:
 * everything becomes one literal phrase, inner quotes doubled.
 */
export function toFtsPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

/** SQL filter fragment over the `c` (conversations) alias. Applied to
 *  the conversation a hit is reported as (a stage hit's parent run). */
function filterClause(db: Db, options: SearchOptions): SQL {
  const parts: SQL[] = [sql`c.trashed_at is null`];
  if (options.includeArchived === false) parts.push(sql`c.archived_at is null`);
  if (options.project === "none") parts.push(sql`c.project_id is null`);
  else if (options.project) parts.push(sql`c.project_id = ${options.project}`);
  if (options.folder) {
    const ids = folderSubtreeIds(db, options.folder);
    parts.push(
      sql`c.folder_id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
  return sql.join(parts, sql` and `);
}

/**
 * Search conversations (0003 + 0007). Two indexes feed one ranked list:
 *
 * - `conversations_fts` over title + summary — what a conversation is
 *   *about*; these matches rank first;
 * - `messages_fts` over message text, bm25-ordered, grouped to one hit
 *   per conversation in TypeScript (snippet() is an FTS5 auxiliary
 *   function and only works on a concrete matched row, so the SQL stays
 *   flat).
 *
 * Trashed conversations are excluded; archived ones are included unless
 * `includeArchived` is false.
 *
 * 0012: a hit in a run's `stage` conversation (`<runId>_<seq>`) is
 * reported as the parent run — searching for something an agent stage
 * said finds the run. Stage rows themselves never surface.
 */
export function searchConversations(
  db: Db,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const limit = options.limit ?? 20;
  const phrase = toFtsPhrase(trimmed);
  const where = filterClause(db, options);

  const metaRows = db.all<{ conversationId: string; snippet: string }>(sql`
    select c.id as conversationId,
           coalesce(
             nullif(snippet(conversations_fts, 1, '[', ']', '…', 12), ''),
             snippet(conversations_fts, 0, '[', ']', '…', 12)
           ) as snippet
    from conversations_fts
    join conversations c on c.rowid = conversations_fts.rowid
    where conversations_fts match ${phrase} and c.kind != 'stage' and ${where}
    order by bm25(conversations_fts, 4.0, 1.0)
    limit ${limit}
  `);

  // `own` is the conversation holding the message; `c` the one reported
  // (itself, or a stage's parent run — the id before the final `_<seq>`).
  const bodyRows = db.all<{ conversationId: string; snippet: string }>(sql`
    select c.id as conversationId,
           snippet(messages_fts, 0, '[', ']', '…', 12) as snippet
    from messages_fts
    join messages m on m.rowid = messages_fts.rowid
    join conversations own on own.id = m.conversation_id
    join conversations c on c.id = case
      when own.kind = 'stage' then rtrim(rtrim(own.id, '0123456789'), '_')
      else own.id end
    where messages_fts match ${phrase} and c.kind != 'stage' and ${where}
    order by bm25(messages_fts), m.at desc
    limit 100
  `);

  // Merge: title/summary matches first (their rank order), then body
  // matches in bm25 order; body row counts accrue to every conversation.
  const order: string[] = [];
  const found = new Map<
    string,
    { snippet: string; hits: number; matchedIn: "title" | "body" }
  >();
  for (const row of metaRows) {
    order.push(row.conversationId);
    found.set(row.conversationId, {
      snippet: row.snippet,
      hits: 0,
      matchedIn: "title",
    });
  }
  for (const row of bodyRows) {
    const existing = found.get(row.conversationId);
    if (existing) {
      existing.hits += 1;
      continue;
    }
    if (found.size >= limit) continue;
    order.push(row.conversationId);
    found.set(row.conversationId, {
      snippet: row.snippet,
      hits: 1,
      matchedIn: "body",
    });
  }
  if (order.length === 0) return [];

  const folderIndex = new Map(
    db
      .select()
      .from(folders)
      .all()
      .map((f) => [f.id, f]),
  );
  const projectName = new Map(
    db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .all()
      .map((p) => [p.id, p.name]),
  );
  const meta = new Map(
    db
      .select({
        id: conversations.id,
        title: conversations.title,
        kind: conversations.kind,
        projectId: conversations.projectId,
        folderId: conversations.folderId,
        archivedAt: conversations.archivedAt,
        updatedAt: conversations.updatedAt,
        parentConversationId: conversations.parentConversationId,
      })
      .from(conversations)
      .all()
      .map((c) => [c.id, c]),
  );

  return order.flatMap((id): SearchHit[] => {
    const c = meta.get(id);
    const f = found.get(id);
    if (!c || !f) return [];
    return [
      {
        conversationId: id,
        kind: c.kind,
        title: c.title,
        snippet: f.snippet,
        hits: f.hits,
        matchedIn: f.matchedIn,
        projectId: c.projectId,
        projectName: c.projectId
          ? (projectName.get(c.projectId) ?? c.projectId)
          : null,
        path: folderPath(folderIndex, c.folderId),
        archived: c.archivedAt !== null,
        updatedAt: c.updatedAt,
        parentTitle: c.parentConversationId ? (meta.get(c.parentConversationId)?.title ?? null) : null,
      },
    ];
  });
}
