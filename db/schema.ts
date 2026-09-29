import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * sweatshop's own store (0002). The conversations table is the app-level
 * index of eve sessions; conversation_events is the derived, append-only
 * mirror of each session's stream (see the dual-write invariants in
 * docs/0002: eve's stream is authoritative; this is a rebuildable
 * materialized view).
 */
export const conversations = sqliteTable(
  "conversations",
  {
    /** eve sessionId (wrun_...). */
    id: text("id").primaryKey(),
    /** First user message, trimmed (~60 chars); null until it arrives. */
    title: text("title"),
    /** Unix ms. */
    createdAt: integer("created_at").notNull(),
    /** Unix ms, bumped on each newly mirrored event. */
    updatedAt: integer("updated_at").notNull(),
    /** Rows mirrored for this conversation (gap audit via rebuild). */
    eventCount: integer("event_count").notNull().default(0),
  },
  (table) => [index("conversations_updated_at_idx").on(table.updatedAt)],
);

export const conversationEvents = sqliteTable(
  "conversation_events",
  {
    /**
     * The evt_ ULID from the event envelope's meta.id — stable across
     * reconnects and replays, so ON CONFLICT DO NOTHING is the correct
     * idempotent ingest (per eve's envelope docs). ULIDs are broadly
     * time-ordered, keeping inserts clustered. Ingestion order is the
     * implicit rowid.
     */
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    /** Loose event type (message.received, step.completed, ...). */
    type: text("type").notNull(),
    /** Raw JSON envelope, stored schemaless to survive eve drift. */
    event: text("event").notNull(),
    /** Unix ms from meta.at. */
    at: integer("at").notNull(),
  },
  (table) => [
    index("conversation_events_conversation_idx").on(table.conversationId),
  ],
);

/**
 * Extracted conversation text (0003): one row per user message
 * (`message.received`) or finalized assistant block (`message.completed`),
 * keyed on the event ULID so extraction is idempotent. `messages_fts`
 * (defined in the migration, not here — drizzle has no FTS5 type) is an
 * external-content index over this table kept in sync by triggers.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    /** "user" | "assistant". */
    role: text("role").notNull(),
    text: text("text").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [index("messages_conversation_idx").on(table.conversationId)],
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type ConversationEvent = typeof conversationEvents.$inferSelect;
export type NewConversationEvent = typeof conversationEvents.$inferInsert;
