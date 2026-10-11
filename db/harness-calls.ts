import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./index";
import { harnessCalls } from "./schema";
import type { HarnessCall } from "./schema";

/**
 * 0022 cut 2: the harness_calls store — identity and status for
 * background chat pi/claude calls. The one-run-per-session slot lives in
 * harness_runs (lib/harness-events, unchanged keying); this row is what
 * inspect/cancel/wake read. Settles stamp `settled_at`; wakes stamp
 * `woken_settled_at` after delivery (the same duplicate-over-loss
 * posture as machine_runs).
 */

export const CALL_SETTLED_STATUSES: ReadonlySet<string> = new Set(["completed", "failed"]);

export function getHarnessCall(db: Db, id: string): HarnessCall | null {
  return db.select().from(harnessCalls).where(eq(harnessCalls.id, id)).get() ?? null;
}

export function listHarnessCalls(
  db: Db,
  filter: { conversationId?: string; limit?: number } = {},
): HarnessCall[] {
  return db
    .select()
    .from(harnessCalls)
    .where(filter.conversationId ? eq(harnessCalls.conversationId, filter.conversationId) : undefined)
    .orderBy(desc(harnessCalls.createdAt))
    .limit(Math.min(filter.limit ?? 50, 200))
    .all();
}

export function createHarnessCall(
  db: Db,
  input: { conversationId: string; kind: "pi" | "claude" | "cursor"; task: string },
  now = Date.now(),
): HarnessCall {
  const id = `hc_${now.toString(36)}${randomUUID().replace(/-/g, "").slice(0, 6)}`;
  db.insert(harnessCalls)
    .values({
      id,
      conversationId: input.conversationId,
      kind: input.kind,
      task: input.task.slice(0, 10_000),
      status: "running",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getHarnessCall(db, id)!;
}

export function setCallWorkflowRun(db: Db, id: string, workflowRunId: string): void {
  db.update(harnessCalls)
    .set({ workflowRunId, updatedAt: Date.now() })
    .where(eq(harnessCalls.id, id))
    .run();
}

/**
 * Settle a call (final for completed/failed; cancelled never wakes).
 * Only a running call settles — a racing cancel wins and a late natural
 * settle is dropped, mirroring markRunCancelled's finality.
 */
export function settleHarnessCall(
  db: Db,
  id: string,
  set: { status: "completed" | "failed" | "cancelled"; result?: string | null; error?: string | null },
  now = Date.now(),
): boolean {
  const settled = set.status !== "cancelled";
  const changes = db
    .update(harnessCalls)
    .set({
      status: set.status,
      result: set.result ?? null,
      error: set.error ?? null,
      ...(settled ? { settledAt: now } : {}),
      updatedAt: now,
    })
    .where(and(eq(harnessCalls.id, id), eq(harnessCalls.status, "running")))
    .run().changes;
  return changes > 0;
}

export function markCallWoken(db: Db, id: string, settledAt: number): void {
  db.update(harnessCalls)
    .set({ wokenSettledAt: settledAt })
    .where(eq(harnessCalls.id, id))
    .run();
}

/** 0022: settled calls whose latest settle has not been delivered. */
export function listWakableCalls(db: Db): HarnessCall[] {
  return db
    .select()
    .from(harnessCalls)
    .where(
      and(
        isNotNull(harnessCalls.settledAt),
        inArray(harnessCalls.status, [...CALL_SETTLED_STATUSES]),
        or(
          isNull(harnessCalls.wokenSettledAt),
          sql`${harnessCalls.wokenSettledAt} < ${harnessCalls.settledAt}`,
        ),
      ),
    )
    .orderBy(harnessCalls.settledAt)
    .limit(50)
    .all();
}
