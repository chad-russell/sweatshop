import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations, harnessEvents, harnessRuns } from "@/db/schema";
import { isBridgeHarnessKind, LANE_BRIDGE_PORTS } from "@/lib/sandboxes/harness-bridge";

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
  /** 0083: the lane this event's call ran in, null for the default lane. */
  readonly dir?: string | null;
}

/**
 * 0083: a short, stable, component-safe (no "/") id for a lane's harness
 * session — distinct per (conversation, dir) so a lane never shares pi's
 * in-process session state (or a bridge-backed harness's internal session
 * bookkeeping) with the default lane or another lane of the same kind.
 */
export function laneSessionId(conversationId: string, dir: string): string {
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return `${conversationId}-${hash}`;
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
  dir?: string,
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
      dir: dir ?? null,
    })
    .run();
}

export interface HarnessEventPage {
  readonly events: readonly HarnessEvent[];
  /** Cursor for the next incremental fetch (null when up to date). */
  readonly cursor: number | null;
  /** Tail/before pages only: whether events older than this page remain
   *  (in the same window) — drives "Load earlier". */
  readonly hasOlder?: boolean;
}

/**
 * One harness's events for a conversation, oldest-first. `afterId`
 * returns only events appended after that id (incremental polling);
 * `limit` bounds each page so long sessions stream in windows instead
 * of truncating at a hard cap (0006). `tail` returns the newest `limit`
 * events instead of the oldest. `fromAt`/`toAt` (inclusive, Unix ms)
 * scope the log to one harness call's time window (0046 per-call view).
 * `beforeId` returns the newest `limit` events older than that id (still
 * oldest-first) — the "Load earlier" page; it implies `tail`.
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
  const filters = [
    eq(harnessEvents.sessionId, sessionId),
    eq(harnessEvents.harness, harness),
  ];
  if (options.afterId !== undefined) {
    filters.push(gt(harnessEvents.id, options.afterId));
  }
  if (options.beforeId !== undefined) {
    filters.push(lt(harnessEvents.id, options.beforeId));
  }
  if (options.fromAt !== undefined) filters.push(gte(harnessEvents.at, options.fromAt));
  if (options.toAt !== undefined) filters.push(lte(harnessEvents.at, options.toAt));
  if (options.tail || options.beforeId !== undefined) {
    // The newest `limit` events, still returned oldest-first — what a live
    // "what is it doing now" peek wants, without paging from the start.
    const newest = db()
      .select()
      .from(harnessEvents)
      .where(and(...filters))
      .orderBy(desc(harnessEvents.id))
      .limit(limit + 1) // one extra row says whether anything older remains
      .all() as HarnessEvent[];
    const hasOlder = newest.length > limit;
    return { events: newest.slice(0, limit).reverse(), cursor: null, hasOlder };
  }
  const rows = db()
    .select()
    .from(harnessEvents)
    .where(and(...filters))
    .orderBy(asc(harnessEvents.id))
    .limit(limit)
    .all() as HarnessEvent[];
  const cursor = rows.length === limit ? rows[rows.length - 1].id : null;
  return { events: rows, cursor };
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
  | { ok: true; port?: number }
  | {
      ok: false;
      /** `same-kind`: this (kind, dir) is already running — one call of a
       *  kind per lane at a time. `cap`: MAX_CONCURRENT_HARNESSES are
       *  already running, regardless of kind or dir. `lane-ports`: every
       *  lane bridge port is already leased to another lane. */
      reason: "same-kind" | "cap" | "lane-ports";
      /** Every run currently holding a slot (any kind, any lane). */
      active: readonly HarnessRun[];
    };

/**
 * Harness run index (harness_runs): status for the UI + /h validity.
 *
 * `claimHarnessRun` atomically claims a concurrency slot (0038: up to
 * MAX_CONCURRENT_HARNESSES running at once per conversation, at most one
 * of each kind; 0083: now scoped per (kind, dir) — a lane claims its own
 * slot alongside the default lane and other lanes of the same kind,
 * harness_runs has one row per (session, kind, dir)). The check-then-start
 * pair runs inside a single synchronous sqlite transaction, so two
 * concurrent tool calls cannot both pass the guard; the claim also
 * (re)writes this slot's row to running, resetting startedAt, toolCalls
 * and error for a fresh run. `dir` omitted (or "") claims the default
 * lane — bit-identical to pre-0083 behavior.
 */
export function claimHarnessRun(
  sessionId: string,
  harness: HarnessKind,
  dir = "",
): ClaimHarnessRunResult {
  const now = Date.now();
  return db().transaction((tx) => {
    const running = tx.query.harnessRuns.findMany({
      where: and(
        eq(harnessRuns.sessionId, sessionId),
        eq(harnessRuns.status, "running"),
      ),
    }).sync() as HarnessRun[];
    if (running.some((r) => r.kind === harness && r.dir === dir)) {
      return { ok: false, reason: "same-kind", active: running };
    }
    if (running.length >= MAX_CONCURRENT_HARNESSES) {
      return { ok: false, reason: "cap", active: running };
    }
    // 0083: a lane of a bridge-backed kind needs its own port (the
    // default lane's fixed per-kind port may already be held). pi lanes
    // and the default lane need none. The pool is leased per SANDBOX, not
    // per conversation — a sandbox can be shared by more than one
    // conversation (an attached child thread, 0037 phase 3), and their
    // bridge processes would otherwise compete for the same container's
    // TCP ports without either side's claim ever seeing the other.
    let port: number | null = null;
    if (dir && isBridgeHarnessKind(harness)) {
      const sandboxId = tx
        .select({ sandboxId: conversations.sandboxId })
        .from(conversations)
        .where(eq(conversations.id, sessionId))
        .get()?.sandboxId ?? null;
      // No bound sandbox yet (this call will provision one): nothing else
      // could be sharing it, so scope to this conversation alone.
      const sharedSessionIds = sandboxId
        ? tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.sandboxId, sandboxId))
            .all()
            .map((r) => r.id)
        : [sessionId];
      const used = new Set(
        tx
          .select({ port: harnessRuns.port })
          .from(harnessRuns)
          .where(
            and(
              inArray(harnessRuns.sessionId, sharedSessionIds),
              eq(harnessRuns.status, "running"),
              ne(harnessRuns.dir, ""),
              isNotNull(harnessRuns.port),
            ),
          )
          .all()
          .map((r) => r.port),
      );
      const free = LANE_BRIDGE_PORTS.find((p) => !used.has(p));
      if (free === undefined) {
        return { ok: false, reason: "lane-ports", active: running };
      }
      port = free;
    }
    tx.insert(harnessRuns)
      .values({
        sessionId,
        kind: harness,
        dir,
        port,
        status: "running",
        toolCalls: 0,
        startedAt: now,
        lastAt: now,
      })
      .onConflictDoUpdate({
        target: [harnessRuns.sessionId, harnessRuns.kind, harnessRuns.dir],
        set: {
          status: "running",
          toolCalls: 0,
          startedAt: now,
          lastAt: now,
          error: null,
          port,
        },
      })
      .run();
    return port !== null ? { ok: true, port } : { ok: true };
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

/** 0083: `dir` must match the claim's — else this would create a brand
 *  new (session, kind, dir) row instead of settling the one actually
 *  running, leaving that slot (and any leased port) stuck "running". */
export function recordHarnessRunEnd(
  sessionId: string,
  harness: HarnessKind,
  toolCalls: number,
  status: "completed" | "failed" | "cancelled",
  error?: string,
  dir = "",
): void {
  const now = Date.now();
  db()
    .insert(harnessRuns)
    .values({
      sessionId,
      kind: harness,
      dir,
      status,
      toolCalls,
      startedAt: now,
      lastAt: now,
      error: error ? clip(error, 500) : null,
      port: null,
    })
    .onConflictDoUpdate({
      target: [harnessRuns.sessionId, harnessRuns.kind, harnessRuns.dir],
      // Settling always releases any leased lane port back to the pool.
      set: { status, toolCalls, lastAt: now, error: error ? clip(error, 500) : null, port: null },
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
  /** 0083: "" for the default lane. */
  dir: string;
  /** 0083: the lane bridge port leased to this run, when it holds one. */
  port?: number | null;
}

export function getHarnessRun(
  sessionId: string,
  harness: HarnessKind = "pi",
  dir = "",
): HarnessRun | null {
  return (
    (db()
      .query.harnessRuns.findFirst({
        where: and(
          eq(harnessRuns.sessionId, sessionId),
          eq(harnessRuns.kind, harness),
          eq(harnessRuns.dir, dir),
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

/** Most-recent run per (harness, lane) for a conversation (sidebar/landing
 *  use) — 0083: keyed by kind+dir now, so a lane's row never shadows the
 *  default lane's (or vice versa) just for being newer. */
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
    const key = `${row.kind}\u0000${row.dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(row);
  }
  return latest;
}
