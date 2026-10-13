import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { Checklist } from "../lib/plan";
import type { Db } from "./index";
import { pendingInputs } from "./schema";

/**
 * 0041: the plan review's store. A review is a `pending_inputs` row of
 * kind `plan` with NO hook behind it — it exists so the Inbox shows
 * "needs you" while the agent keeps working. The row id is the
 * present_plan tool call id; its card carries the snapshot. The latest
 * plan row of a conversation is its state: none → never presented,
 * unresolved → in review, answered `{approved: true}` → approved
 * (superseded rows are always older than the row that superseded them).
 */

/** What a plan row's card (and accept_plan's approval card) carries. */
export interface PlanCard {
  kind: "plan";
  version: number;
  markdown: string;
  checklist: Checklist;
  note?: string;
}

export function isPlanCard(value: unknown): value is PlanCard {
  const v = value as Partial<PlanCard> | null | undefined;
  return !!v && v.kind === "plan" && typeof v.version === "number" && typeof v.markdown === "string";
}

export interface PlanRow {
  id: string;
  conversationId: string;
  card: PlanCard | null;
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

function toRow(row: typeof pendingInputs.$inferSelect): PlanRow {
  const card = parse<unknown>(row.card);
  return {
    id: row.id,
    conversationId: row.conversationId,
    card: isPlanCard(card) ? card : null,
    resolvedAt: row.resolvedAt,
    answer: parse(row.answer),
    createdAt: row.createdAt,
  };
}

export function getPlanRow(db: Conn, id: string): PlanRow | null {
  const row = db
    .select()
    .from(pendingInputs)
    .where(and(eq(pendingInputs.id, id), eq(pendingInputs.kind, "plan")))
    .get();
  return row ? toRow(row) : null;
}

/** The conversation's newest plan row (rowid breaks same-ms ties). */
export function latestPlanRow(db: Conn, conversationId: string): PlanRow | null {
  const row = db
    .select()
    .from(pendingInputs)
    .where(and(eq(pendingInputs.conversationId, conversationId), eq(pendingInputs.kind, "plan")))
    .orderBy(desc(pendingInputs.createdAt), desc(pendingInputs.id))
    .limit(1)
    .get();
  return row ? toRow(row) : null;
}

export type PlanState =
  | { kind: "none" }
  | { kind: "review"; row: PlanRow }
  | { kind: "approved"; row: PlanRow };

export function planState(db: Conn, conversationId: string): PlanState {
  const row = latestPlanRow(db, conversationId);
  if (!row) return { kind: "none" };
  if (row.resolvedAt === null) return { kind: "review", row };
  if (row.answer?.approved === true) return { kind: "approved", row };
  // A superseded latest row cannot happen (its superseder is newer); be
  // safe and treat anything else as "not approved".
  return { kind: "none" };
}

/** Open a review for a snapshot: supersede any open one, insert the row. */
export function openPlanReview(
  db: Conn,
  input: { id: string; conversationId: string; card: PlanCard },
): void {
  const now = Date.now();
  db.update(pendingInputs)
    .set({ resolvedAt: now, answer: JSON.stringify({ superseded: true, by: input.id }) })
    .where(
      and(
        eq(pendingInputs.conversationId, input.conversationId),
        eq(pendingInputs.kind, "plan"),
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
      kind: "plan",
      question: `Plan v${version}${note ? ` — ${note}` : ""}`,
      card: JSON.stringify(input.card),
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
}

/** Approve an open review. Running-only: false when it was already answered. */
export function approvePlanRow(db: Conn, id: string, note?: string): boolean {
  const res = db
    .update(pendingInputs)
    .set({ resolvedAt: Date.now(), answer: JSON.stringify({ approved: true, ...(note ? { note } : {}) }) })
    .where(and(eq(pendingInputs.id, id), eq(pendingInputs.kind, "plan"), isNull(pendingInputs.resolvedAt)))
    .run() as unknown as { changes?: number };
  return (res.changes ?? 0) > 0;
}

/** Unresolved accept_plan approvals of a conversation (approval rows whose
 *  card is a plan) — the plan card's button answers these too. */
export function pendingAcceptPlanIds(db: Conn, conversationId: string): string[] {
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
    .filter((r) => isPlanCard(parse(r.card)))
    .map((r) => r.id);
}
