import { eq, sql } from "drizzle-orm";
import type { Db } from "../index";
import { chatHarnessState, conversations } from "../schema";

/**
 * 0010 Phase 3b / 0077: a conversation's live-turn state — which
 * workflow run is active, its durable stream-replay cursor, and (per
 * harness) the `resumeFrom` handle that lets a later harness tool call
 * continue the same session with prior context.
 */

/**
 * A conversation × harness's `resumeFrom` handle — the durable session
 * continuity for harness tool calls (next call resumes the same harness
 * session with prior context).
 */
export function getHarnessResumeState(
  db: Db,
  conversationId: string,
  harness: string,
): unknown | null {
  const row = db
    .select({ resumeFrom: chatHarnessState.resumeFrom })
    .from(chatHarnessState)
    .where(
      sql`${chatHarnessState.conversationId} = ${conversationId} and ${chatHarnessState.harness} = ${harness}`,
    )
    .get();
  return row ? (JSON.parse(row.resumeFrom) as unknown) : null;
}

export function saveHarnessResumeState(
  db: Db,
  conversationId: string,
  harness: string,
  resumeFrom: unknown,
): void {
  db.insert(chatHarnessState)
    .values({
      conversationId,
      harness,
      resumeFrom: JSON.stringify(resumeFrom),
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      set: { resumeFrom: JSON.stringify(resumeFrom), updatedAt: Date.now() },
      target: [chatHarnessState.conversationId, chatHarnessState.harness],
    })
    .run();
}

/** Record which turn workflow run is live for this conversation. 0077:
 *  the stream cursor is a property of ONE live run, so it always resets
 *  alongside it — starting a run has no cursor yet (persistTurn's first
 *  non-final slice writes one), and clearing the run clears any cursor
 *  it left behind. */
export function setActiveRun(db: Db, conversationId: string, runId: string | null): void {
  db.update(conversations)
    .set({ activeRunId: runId, activeStreamCursor: null })
    .where(eq(conversations.id, conversationId))
    .run();
}

/** Clear the active run (and its stream cursor) only if it still points
 *  at `runId`. */
export function clearActiveRunIfMatches(db: Db, conversationId: string, runId: string): void {
  db.update(conversations)
    .set({ activeRunId: null, activeStreamCursor: null })
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

/** 0077: the live run's resume cursor — raw journal chunks already
 *  durably written (null before the first slice persists, or once no
 *  run is live). `/from/<cursor>/stream` starts reading here. */
export function getActiveStreamCursor(db: Db, conversationId: string): number | null {
  const row = db
    .select({ activeStreamCursor: conversations.activeStreamCursor })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return row?.activeStreamCursor ?? null;
}

/** 0077: record the live run's resume cursor — called after each
 *  non-final `persistTurn` slice, while `activeRunId` is still set. */
export function setActiveStreamCursor(db: Db, conversationId: string, cursor: number): void {
  db.update(conversations)
    .set({ activeStreamCursor: cursor })
    .where(eq(conversations.id, conversationId))
    .run();
}
