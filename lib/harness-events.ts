import { and, asc, desc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { harnessEvents, harnessRuns } from "@/db/schema";

/**
 * 0005/0006 harness visibility: harness events per conversation ×
 * harness, stored in sqlite — the eve runtime writes, the Next server
 * reads (WAL is the cross-process transport), and the log is durable.
 */

/** Harnesses with a first-class Eve tool (0006). */
export const HARNESS_KINDS = ["pi", "claude"] as const;
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
    | "step-end"
    | "end";
  readonly toolName?: string | null;
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
      input: event.input ?? null,
      output: event.output ?? null,
      text: event.text ?? null,
    })
    .run();
}

export interface HarnessEventPage {
  readonly events: readonly HarnessEvent[];
  /** Cursor for the next incremental fetch (null when up to date). */
  readonly cursor: number | null;
}

/**
 * One harness's events for a conversation, oldest-first. `afterId`
 * returns only events appended after that id (incremental polling);
 * `limit` bounds each page so long sessions stream in windows instead
 * of truncating at a hard cap (0006).
 */
export function getHarnessEvents(
  sessionId: string,
  harness: HarnessKind = "pi",
  options: { afterId?: number; limit?: number } = {},
): HarnessEventPage {
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000);
  const filters = [
    eq(harnessEvents.sessionId, sessionId),
    eq(harnessEvents.harness, harness),
  ];
  if (options.afterId !== undefined) {
    filters.push(gt(harnessEvents.id, options.afterId));
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
 * Harness run index (harness_runs): status for the UI + /h validity.
 *
 * `claimHarnessRun` atomically claims the v1 concurrency slot — one
 * harness at a time per conversation (0006). The check-then-start pair
 * runs inside a single synchronous sqlite transaction, so two
 * concurrent tool calls cannot both pass the guard; the claim also
 * (re)writes this harness's row to running, resetting startedAt,
 * toolCalls and error for a fresh run. Returns false when any harness
 * already holds the slot.
 */
export function claimHarnessRun(
  sessionId: string,
  harness: HarnessKind,
): boolean {
  const now = Date.now();
  return db().transaction((tx) => {
    const active = tx.query.harnessRuns.findFirst({
      where: and(
        eq(harnessRuns.sessionId, sessionId),
        eq(harnessRuns.status, "running"),
      ),
    }).sync();
    if (active) return false;
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
    return true;
  });
}

export function recordHarnessRunEnd(
  sessionId: string,
  harness: HarnessKind,
  toolCalls: number,
  status: "completed" | "failed",
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
 * Any harness run still marked running for a conversation — the v1
 * concurrency guard: one harness at a time per sandbox (0006).
 */
export function getActiveHarnessRun(sessionId: string): HarnessRun | null {
  return (
    (db()
      .query.harnessRuns.findFirst({
        where: and(
          eq(harnessRuns.sessionId, sessionId),
          eq(harnessRuns.status, "running"),
        ),
      })
      .sync() as HarnessRun | undefined) ?? null
  );
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
