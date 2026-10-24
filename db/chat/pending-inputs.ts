import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../index";
import { pendingInputs } from "../schema";
import { appendMessages } from "./messages";

/**
 * 0010 Phase 4: pending human input on the new chat runtime. The tool
 * records the request before awaiting its hook; the resume route marks
 * it answered. The inbox reads unresolved rows (db/attention.ts's
 * `loadPendingRequests` is the read side proper — these are the writes
 * plus the two lookups the chat tools themselves need).
 */
export function recordPendingInput(
  db: Db,
  input: { id: string; conversationId: string; kind: string; question: string; card?: unknown },
): void {
  const { card, ...row } = input;
  db.insert(pendingInputs)
    .values({ ...row, card: card === undefined ? null : JSON.stringify(card), createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
}

export function resolvePendingInput(
  db: Db,
  id: string,
  answer: unknown,
): void {
  db.update(pendingInputs)
    .set({ resolvedAt: Date.now(), answer: JSON.stringify(answer) })
    .where(eq(pendingInputs.id, id))
    .run();
}

/**
 * Resolve every unresolved non-plan/outline pending input of a
 * conversation whose turn can no longer resume: the hook died with its
 * run (cancelled, failed, expired — a resume is "Hook not found"), so the
 * inbox card must not outlive it (2026-10-13: two stuck PR approvals
 * had no working button). Plan and outline reviews are hookless (0041,
 * 0064) and stay. `reason` lands in the row's answer for the record.
 * Returns the ids cleared — an empty list means nothing was orphaned.
 */
export function resolveOrphanedPendingInputs(
  db: Db,
  conversationId: string,
  reason: string,
): string[] {
  const rows = db
    .select({ id: pendingInputs.id, kind: pendingInputs.kind, question: pendingInputs.question })
    .from(pendingInputs)
    .where(
      and(
        eq(pendingInputs.conversationId, conversationId),
        isNull(pendingInputs.resolvedAt),
        ne(pendingInputs.kind, "plan"),
        ne(pendingInputs.kind, "outline"),
      ),
    )
    .all();
  if (rows.length > 0) {
    db.update(pendingInputs)
      .set({ resolvedAt: Date.now(), answer: JSON.stringify({ orphaned: reason }) })
      .where(
        and(
          inArray(pendingInputs.id, rows.map((row) => row.id)),
          isNull(pendingInputs.resolvedAt),
        ),
      )
      .run();
    // 0043: the suspended slice never persisted (a slice lands only when
    // it completes), so a cancelled or crashed turn showed nothing of
    // the ask it died on. Leave one honest note row per orphan — the
    // question text is the durable summary, and a plain assistant row
    // keeps the next model call free of dangling tool-calls.
    appendMessages(
      db,
      conversationId,
      rows.map((row) => {
        const text = `[stopped — ${reason}] was waiting on ${row.kind === "question" ? "your answer" : "your approval"}:\n\n${row.question}`.slice(0, 600);
        return {
          id: `cx_${conversationId}_${row.id}`,
          role: "assistant" as const,
          text,
          modelMessage: { role: "assistant" as const, content: text },
        };
      }),
    );
  }
  return rows.map((row) => row.id);
}

/** 0037: a pending input's runtime-built card evidence (null = none,
 *  or no such row). */
export function getPendingInputCard(db: Db, id: string): unknown {
  const row = db.select({ card: pendingInputs.card }).from(pendingInputs).where(eq(pendingInputs.id, id)).get();
  if (!row?.card) return null;
  try {
    return JSON.parse(row.card) as unknown;
  } catch {
    return null;
  }
}

export function listPendingInputs(
  db: Db,
  conversationId?: string,
): {
  id: string;
  conversationId: string;
  kind: string;
  question: string;
  createdAt: number;
}[] {
  const where = conversationId
    ? sql`${pendingInputs.conversationId} = ${conversationId} and ${pendingInputs.resolvedAt} is null`
    : sql`${pendingInputs.resolvedAt} is null`;
  return db
    .select({
      id: pendingInputs.id,
      conversationId: pendingInputs.conversationId,
      kind: pendingInputs.kind,
      question: pendingInputs.question,
      createdAt: pendingInputs.createdAt,
    })
    .from(pendingInputs)
    .where(where)
    .orderBy(asc(pendingInputs.createdAt))
    .all();
}
