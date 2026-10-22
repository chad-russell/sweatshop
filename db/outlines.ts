import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { isOutlineCard, type OutlineCard } from "../lib/outline";
import type { Db } from "./index";
import { pendingInputs } from "./schema";

/**
 * 0064: the outline review's store — the same `pending_inputs` mechanism
 * 0041 built for plans (db/plans.ts), with kind `outline`: a row with NO
 * hook behind it, opened by `update_outline({..., propose: true})`. It
 * exists so the Inbox shows "needs you" while the agent keeps working —
 * propose never blocks the turn. The row id is the update_outline tool
 * call id; its card carries the proposed snapshot. The latest outline row
 * of a conversation is its review state: none → never proposed,
 * unresolved → in review, answered `{approved: true}` → approved
 * (superseded rows are always older than the row that superseded them).
 */

export { isOutlineCard, type OutlineCard };

export interface OutlineRow {
  id: string;
  conversationId: string;
  card: OutlineCard | null;
  resolvedAt: number | null;
  answer: { approved?: boolean; superseded?: boolean; note?: string } | null;
  createdAt: number;
}

type Conn = Pick<Db, "select" | "insert" | "update">;

function parse<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function toRow(row: typeof pendingInputs.$inferSelect): OutlineRow {
  const card = parse<unknown>(row.card);
  return {
    id: row.id,
    conversationId: row.conversationId,
    card: isOutlineCard(card) ? card : null,
    resolvedAt: row.resolvedAt,
    answer: parse(row.answer),
    createdAt: row.createdAt,
  };
}

export function getOutlineRow(db: Conn, id: string): OutlineRow | null {
  const row = db
    .select()
    .from(pendingInputs)
    .where(and(eq(pendingInputs.id, id), eq(pendingInputs.kind, "outline")))
    .get();
  return row ? toRow(row) : null;
}

/** The conversation's newest outline row (rowid breaks same-ms ties). */
export function latestOutlineRow(db: Conn, conversationId: string): OutlineRow | null {
  const row = db
    .select()
    .from(pendingInputs)
    .where(and(eq(pendingInputs.conversationId, conversationId), eq(pendingInputs.kind, "outline")))
    .orderBy(desc(pendingInputs.createdAt), desc(pendingInputs.id))
    .limit(1)
    .get();
  return row ? toRow(row) : null;
}

export type OutlineReviewState =
  | { kind: "none" }
  | { kind: "review"; row: OutlineRow }
  | { kind: "approved"; row: OutlineRow };

export function outlineState(db: Conn, conversationId: string): OutlineReviewState {
  const row = latestOutlineRow(db, conversationId);
  if (!row) return { kind: "none" };
  if (row.resolvedAt === null) return { kind: "review", row };
  if (row.answer?.approved === true) return { kind: "approved", row };
  // A superseded latest row cannot happen (its superseder is newer); be
  // safe and treat anything else as "not approved".
  return { kind: "none" };
}

/** Open a review for a proposed snapshot: supersede any open one, insert the row. */
export function openOutlineReview(
  db: Conn,
  input: { id: string; conversationId: string; card: OutlineCard },
): void {
  const now = Date.now();
  db.update(pendingInputs)
    .set({ resolvedAt: now, answer: JSON.stringify({ superseded: true, by: input.id }) })
    .where(
      and(
        eq(pendingInputs.conversationId, input.conversationId),
        eq(pendingInputs.kind, "outline"),
        isNull(pendingInputs.resolvedAt),
        ne(pendingInputs.id, input.id),
      ),
    )
    .run();
  const { version, note } = input.card;
  db.insert(pendingInputs)
    .values({
      id: input.id,
      conversationId: input.conversationId,
      kind: "outline",
      question: `Outline v${version}${note ? ` — ${note}` : ""}`,
      card: JSON.stringify(input.card),
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
}

/** Approve an open review. Running-only: false when it was already answered. */
export function approveOutlineRow(db: Conn, id: string, note?: string): boolean {
  const res = db
    .update(pendingInputs)
    .set({ resolvedAt: Date.now(), answer: JSON.stringify({ approved: true, ...(note ? { note } : {}) }) })
    .where(and(eq(pendingInputs.id, id), eq(pendingInputs.kind, "outline"), isNull(pendingInputs.resolvedAt)))
    .run() as unknown as { changes?: number };
  return (res.changes ?? 0) > 0;
}

/** Unresolved accept_outline approvals of a conversation (the outline
 *  card's button answers these too). */
export function pendingAcceptOutlineIds(db: Conn, conversationId: string): string[] {
  return db
    .select({ id: pendingInputs.id, card: pendingInputs.card })
    .from(pendingInputs)
    .where(
      and(
        eq(pendingInputs.conversationId, conversationId),
        eq(pendingInputs.kind, "approval"),
        isNull(pendingInputs.resolvedAt),
      ),
    )
    .all()
    .filter((r) => isOutlineCard(parse(r.card)))
    .map((r) => r.id);
}
