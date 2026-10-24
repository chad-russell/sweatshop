import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../index";
import { steerQueue } from "../schema";

/** 0010 spike store: the mid-turn steer queue — a message sent onto a
 *  live turn drains into the next slice instead of starting a new one. */

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
