import { and, asc, desc, eq, gt, gte, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { harnessEvents, harnessRuns } from "@/db/schema";

/**
 * 0005/0006 harness visibility: harness events per conversation ×
 * harness, stored in sqlite — the eve runtime writes, the Next server
 * reads (WAL is the cross-process transport), and the log is durable.
 */

/** Harnesses with a first-class tool (0006; cursor 0038, codex 0050). */
export const HARNESS_KINDS = ["pi", "claude", "cursor", "codex"] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

export function isHarnessKind(value: string): value is HarnessKind {
  return (HARNESS_KINDS as readonly string[]).includes(value);
}

export interface HarnessEvent {
  readonly id: number;
  readonly at: number;
  readonly kind:
    | "start"
    | "step-start"
    | "tool-start"
    | "tool-end"
    | "tool-error"
    | "step-end"
    | "end";
  readonly toolName?: string | null;
  /** Pairs tool-start with its tool-end/tool-error; null on pre-0025 rows. */
  readonly toolCallId?: string | null;
  readonly input?: string | null;
  readonly output?: string | null;
  readonly text?: string | null;
}

function clip(value: unknown, max = 2000): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function recordHarnessEvent(
  sessionId: string,
  harness: HarnessKind,
  event: Omit<HarnessEvent, "id" | "at">,
): void {
  db()
    .insert(harnessEvents)
    .values({
      sessionId,
      harness,
      at: Date.now(),
      kind: event.kind,
      toolName: event.toolName ?? null,
      toolCallId: event.toolCallId ?? null,
      input: event.input ?? null,
      output: event.output ?? null,
      text: event.text ?? null,
    })
    .run();
}

export interface HarnessEventPage {
  readonly events: readonly HarnessEvent[];
  /** Cursor for the next fetch in the page's direction: the id of the
   *  page's last row for an oldest-first/`afterId` read (incremental
   *  polling), or the id of the page's OLDEST row for a `tail`/`beforeId`
   *  read — the `beforeId` for the next page back. Null = nothing more
   *  in that direction. */
  readonly cursor: number | null;
  /** How many matching rows sit past the page in the same direction:
   *  older rows for `tail`/`beforeId` (the "~N more" a load-earlier
   *  control shows), unfetched newer rows for `afterId`. */
  readonly remaining: number;
}

/**
 * One harness's events for a conversation, oldest-first. `afterId`
 * returns only events appended after that id (incremental polling);
 * `limit` bounds each page so long sessions stream in windows instead
 * of truncating at a hard cap (0006). `tail` returns the newest `limit`
 * events instead of the oldest; `beforeId` pages strictly older than
 * that id — both load from the end (0075), composing with the
 * `fromAt`/`toAt` window (inclusive, Unix ms) that scopes the log to
 * one harness call (0046 per-call view).
 */
export function getHarnessEvents(
  sessionId: string,
  harness: HarnessKind = "pi",
  options: {
    afterId?: number;
    beforeId?: number;
    limit?: number;
    tail?: boolean;
    fromAt?: number;
    toAt?: number;
  } = {},
): HarnessEventPage {
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000);
  // Window filters (no id bounds) — reused by the older-rows count so
  // `remaining` always counts the same population the pages read.
  const base = [
    eq(harnessEvents.sessionId, sessionId),
    eq(harnessEvents.harness, harness),
  ];
  if (options.fromAt !== undefined) base.push(gte(harnessEvents.at, options.fromAt));
  if (options.toAt !== undefined) base.push(lte(harnessEvents.at, options.toAt));
  const filters = [...base];
  if (options.afterId !== undefined) {
    filters.push(gt(harnessEvents.id, options.afterId));
  }
  const countOlder = (oldestId: number): number =>
    db()
      .select({ n: sql<number>`count(*)` })
      .from(harnessEvents)
      .where(and(...base, lt(harnessEvents.id, oldestId)))
      .get()?.n ?? 0;
  if (options.tail || options.beforeId !== undefined) {
    // Load from the end (0075): the newest `limit` rows under the
    // filters (`tail`), or the page strictly below `beforeId`. Read
    // newest-first, return oldest-first — the cursor points BACK to the
    // next older page, null when the window's start is reached.
    const paged = [...filters];
    if (options.beforeId !== undefined) paged.push(lt(harnessEvents.id, options.beforeId));
    const newest = db()
      .select()
      .from(harnessEvents)
      .where(and(...paged))
      .orderBy(desc(harnessEvents.id))
      .limit(limit)
      .all() as HarnessEvent[];
    const page = newest.reverse();
    if (page.length === 0) return { events: page, cursor: null, remaining: 0 };
    const remaining = countOlder(page[0].id);
    return { events: page, cursor: remaining > 0 ? page[0].id : null, remaining };
  }
  const rows = db()
    .select()
    .from(harnessEvents)
    .where(and(...filters))
    .orderBy(asc(harnessEvents.id))
    .limit(limit)
    .all() as HarnessEvent[];
  const cursor = rows.length === limit ? rows[rows.length - 1].id : null;
  // The cheap symmetric extra: how many newer rows a poll still owes.
  const remaining =
    cursor === null
      ? 0
      : (db()
          .select({ n: sql<number>`count(*)` })
          .from(harnessEvents)
          .where(and(...base, gt(harnessEvents.id, cursor)))
          .get()?.n ?? 0);
  return { events: rows, cursor, remaining };
}

export const clipHarnessText = clip;

/**
 * 0038 amendment: more than one harness may run at once per conversation
 * (they share the sandbox's checkout — the chat instructions tell the
 * model to use separate files/areas, or `start_thread({fresh:true})` for
 * work that could collide), but not without bound — each bridge-backed
 * kind holds a process and a port, and an unbounded pile of background
 * calls would make the chat's own turns compete for the same sandbox.
 */
export const MAX_CONCURRENT_HARNESSES = 3;

export type ClaimHarnessRunResult =
  | { ok: true }
  | {
      ok: false;
      /** `same-kind`: this kind is already running — one call of a kind
       *  at a time. `cap`: MAX_CONCURRENT_HARNESSES are already running,
       *  regardless of kind. */
      reason: "same-kind" | "cap";
      /** Every run currently holding a slot (any kind). */
      active: readonly HarnessRun[];
    };

/**
 * Harness run index (harness_runs): status for the UI + /h validity.
 *
 * `claimHarnessRun` atomically claims a concurrency slot (0038: up to
 * MAX_CONCURRENT_HARNESSES running at once per conversation, at most one
 * of each kind — harness_runs already has one row per (session, kind)).
 * The check-then-start pair runs inside a single synchronous sqlite
 * transaction, so two concurrent tool calls cannot both pass the guard;
 * the claim also (re)writes this harness's row to running, resetting
 * startedAt, toolCalls and error for a fresh run.
 */
export function claimHarnessRun(
  sessionId: string,
  harness: HarnessKind,
): ClaimHarnessRunResult {
  const now = Date.now();
  return db().transaction((tx) => {
    const running = tx.query.harnessRuns.findMany({
      where: and(
        eq(harnessRuns.sessionId, sessionId),
        eq(harnessRuns.status, "running"),
      ),
    }).sync() as HarnessRun[];
    if (running.some((r) => r.kind === harness)) {
      return { ok: false, reason: "same-kind", active: running };
    }
    if (running.length >= MAX_CONCURRENT_HARNESSES) {
      return { ok: false, reason: "cap", active: running };
    }
    tx.insert(harnessRuns)
      .values({
        sessionId,
        kind: harness,
        status: "running",
        toolCalls: 0,
        startedAt: now,
        lastAt: now,
      })
      .onConflictDoUpdate({
        target: [harnessRuns.sessionId, harnessRuns.kind],
        set: {
          status: "running",
          toolCalls: 0,
          startedAt: now,
          lastAt: now,
          error: null,
        },
      })
      .run();
    return { ok: true };
  });
}

/** Tool calls a session actually made (its tool-start events) — the
 *  counter machine-stage visits settle with (2026-10-09 friction fix:
 *  the old code re-read the zero the claim had written). */
export function countToolCalls(sessionId: string, harness: HarnessKind): number {
  return db()
    .select({ n: sql<number>`count(*)` })
    .from(harnessEvents)
    .where(and(eq(harnessEvents.sessionId, sessionId), eq(harnessEvents.harness, harness), eq(harnessEvents.kind, "tool-start")))
    .get()?.n ?? 0;
}

export function recordHarnessRunEnd(
  sessionId: string,
  harness: HarnessKind,
  toolCalls: number,
  status: "completed" | "failed" | "cancelled",
  error?: string,
): void {
  const now = Date.now();
  db()
    .insert(harnessRuns)
    .values({
      sessionId,
      kind: harness,
      status,
      toolCalls,
      startedAt: now,
      lastAt: now,
      error: error ? clip(error, 500) : null,
    })
    .onConflictDoUpdate({
      target: [harnessRuns.sessionId, harnessRuns.kind],
      set: { status, toolCalls, lastAt: now, error: error ? clip(error, 500) : null },
    })
    .run();
}

export interface HarnessRun {
  sessionId: string;
  kind: string;
  status: string;
  toolCalls: number;
  startedAt: number;
  lastAt: number;
  error?: string | null;
}

export function getHarnessRun(
  sessionId: string,
  harness: HarnessKind = "pi",
): HarnessRun | null {
  return (
    (db()
      .query.harnessRuns.findFirst({
        where: and(
          eq(harnessRuns.sessionId, sessionId),
          eq(harnessRuns.kind, harness),
        ),
      })
      .sync() as HarnessRun | undefined) ?? null
  );
}

/**
 * 0038 amendment: every harness run still marked running for a
 * conversation (any kind) — up to MAX_CONCURRENT_HARNESSES, at most one
 * per kind. Replaces the old single-slot `getActiveHarnessRun`.
 */
export function listActiveHarnessRuns(sessionId: string): readonly HarnessRun[] {
  return db()
    .query.harnessRuns.findMany({
      where: and(
        eq(harnessRuns.sessionId, sessionId),
        eq(harnessRuns.status, "running"),
      ),
    })
    .sync() as HarnessRun[];
}

/** Most-recent run per harness for a conversation (sidebar/landing use). */
export function listHarnessRuns(sessionId: string): readonly HarnessRun[] {
  const rows = db()
    .select()
    .from(harnessRuns)
    .where(eq(harnessRuns.sessionId, sessionId))
    .orderBy(desc(harnessRuns.lastAt))
    .all() as HarnessRun[];
  const seen = new Set<string>();
  const latest: HarnessRun[] = [];
  for (const row of rows) {
    if (seen.has(row.kind)) continue;
    seen.add(row.kind);
    latest.push(row);
  }
  return latest;
}
