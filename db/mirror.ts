import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "./index";
import { conversationEvents, conversations } from "./schema";

/**
 * The 0002 event mirror: a derived, append-only projection of eve's
 * authoritative stream into sweatshop's sqlite store. Invariants (see
 * docs/0002 "The dual-write rules"): one-way, rebuildable,
 * schema-insulated, failsafe, auditable. Nothing behavioral ever reads
 * this data.
 */

/** The eve stream event envelope (type + data + meta). */
export interface StreamEventEnvelope {
  type: string;
  data?: unknown;
  meta?: { id?: string; at?: string };
}

const TITLE_MAX = 60;

/** First user message → conversation title: whitespace collapsed, ~60 chars. */
export function titleFromMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > TITLE_MAX
    ? `${collapsed.slice(0, TITLE_MAX - 1).trimEnd()}…`
    : collapsed;
}

/**
 * Mirror one stream event. Failsafe by rule 4: write failures are logged
 * (stable [mirror] prefix) and never propagate into the stream.
 */
export function mirrorStreamEvent(
  sessionId: string,
  event: StreamEventEnvelope,
): void {
  try {
    mirrorUnchecked(sessionId, event);
  } catch (err) {
    console.error("[mirror] write failed", sessionId, event.type, err);
  }
}

function mirrorUnchecked(sessionId: string, event: StreamEventEnvelope): void {
  // Events predating stream version 20 carry no meta.id and cannot be
  // deduplicated (envelope docs) — skip rather than risk duplicate rows.
  const id = event.meta?.id;
  if (!id) return;

  const now = Date.now();
  const at = event.meta?.at ? (Date.parse(event.meta.at) || now) : now;

  // Ensure the conversation row exists — hooks also observe sessions
  // created before the mirror did (idempotent upsert).
  db()
    .insert(conversations)
    .values({ id: sessionId, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();

  // Title from the first user message, only while untitled.
  if (event.type === "message.received") {
    const data = event.data as
      | { message?: unknown; kind?: unknown }
      | undefined;
    if (data?.kind !== "execution.background_task") {
      const title = titleFromMessage(data?.message);
      if (title !== null) {
        db()
          .update(conversations)
          .set({ title })
          .where(
            and(eq(conversations.id, sessionId), isNull(conversations.title)),
          )
          .run();
      }
    }
  }

  // Idempotent ingest keyed on the envelope's evt_ ULID.
  const inserted = db()
    .insert(conversationEvents)
    .values({
      id,
      conversationId: sessionId,
      type: event.type,
      event: JSON.stringify(event),
      at,
    })
    .onConflictDoNothing()
    .run();

  if (inserted.changes > 0) {
    db()
      .update(conversations)
      .set({ updatedAt: now, eventCount: sql`${conversations.eventCount} + 1` })
      .where(eq(conversations.id, sessionId))
      .run();
  }
}
