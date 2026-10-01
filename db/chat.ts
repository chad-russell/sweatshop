import { asc, eq, sql } from "drizzle-orm";
import type { ModelMessage } from "ai";
import type { Db } from "./index";
import { conversations, messages, steerQueue } from "./schema";

/**
 * 0010 spike store: the new chat runtime's own tables. The mirror
 * (db/mirror.ts) keeps writing eve conversations exactly as before; these
 * helpers serve `/x` conversations whose source of truth is `messages`
 * rows with a serialized ModelMessage, not the event mirror.
 *
 * Rows are append-only and read back in insertion order (rowid); ids are
 * content-stable per turn so step retries cannot duplicate them.
 */

export interface NewMessageRow {
  id: string;
  role: "user" | "assistant" | "tool";
  /** Plain-text extraction (search/display fallback). */
  text: string;
  /** The ModelMessage this row persists. */
  modelMessage: ModelMessage;
}

/** Create the conversation row if absent (new-runtime ids: `c_…`). */
export function ensureConversation(
  db: Db,
  id: string,
  projectId: string | null = null,
): void {
  const now = Date.now();
  db.insert(conversations)
    .values({ id, projectId, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

/** Append message rows for one conversation (order = insertion order). */
export function appendMessages(
  db: Db,
  conversationId: string,
  rows: NewMessageRow[],
): void {
  if (rows.length === 0) return;
  const at = Date.now();
  db.insert(messages)
    .values(
      rows.map((row) => ({
        id: row.id,
        conversationId,
        role: row.role,
        text: row.text,
        modelMessage: JSON.stringify(row.modelMessage),
        at,
      })),
    )
    .onConflictDoNothing()
    .run();
  db.update(conversations)
    .set({ updatedAt: at })
    .where(eq(conversations.id, conversationId))
    .run();
}

/** The conversation's persisted model history, in insertion order. */
export function listModelMessages(db: Db, conversationId: string): ModelMessage[] {
  const rows = db
    .select({ modelMessage: messages.modelMessage, role: messages.role, text: messages.text })
    .from(messages)
    .where(sql`${messages.conversationId} = ${conversationId} and ${messages.modelMessage} is not null`)
    .orderBy(asc(sql`rowid`))
    .all();
  return rows.map((row) => JSON.parse(row.modelMessage!) as ModelMessage);
}

/** Simple {role, text} view of every message row (spike page reload). */
export function listMessageTexts(
  db: Db,
  conversationId: string,
): { id: string; role: string; text: string; at: number }[] {
  return db
    .select({
      id: messages.id,
      role: messages.role,
      text: messages.text,
      at: messages.at,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(sql`rowid`))
    .all();
}

/** Queue a steer message for a conversation with a live turn. */
export function enqueueSteer(db: Db, conversationId: string, text: string): void {
  db.insert(steerQueue)
    .values({
      id: `s_${conversationId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      text,
      createdAt: Date.now(),
    })
    .run();
}

/** Steer texts for a conversation, oldest first, WITHOUT consuming them. */
export function peekSteer(db: Db, conversationId: string): string[] {
  return db
    .select({ text: steerQueue.text })
    .from(steerQueue)
    .where(eq(steerQueue.conversationId, conversationId))
    .orderBy(asc(sql`rowid`))
    .all()
    .map((row) => row.text);
}

/** Consume the steer queue (mid-turn drain / next-turn fold). */
export function drainSteer(db: Db, conversationId: string): string[] {
  const texts = peekSteer(db, conversationId);
  if (texts.length > 0) {
    db.delete(steerQueue)
      .where(eq(steerQueue.conversationId, conversationId))
      .run();
  }
  return texts;
}

/** Record which turn workflow run is live for this conversation. */
export function setActiveRun(db: Db, conversationId: string, runId: string | null): void {
  db.update(conversations)
    .set({ activeRunId: runId })
    .where(eq(conversations.id, conversationId))
    .run();
}

/** Clear the active run only if it still points at `runId`. */
export function clearActiveRunIfMatches(db: Db, conversationId: string, runId: string): void {
  db.update(conversations)
    .set({ activeRunId: null })
    .where(
      sql`${conversations.id} = ${conversationId} and ${conversations.activeRunId} = ${runId}`,
    )
    .run();
}

export function getActiveRun(db: Db, conversationId: string): string | null {
  const row = db
    .select({ activeRunId: conversations.activeRunId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return row?.activeRunId ?? null;
}
