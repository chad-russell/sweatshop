import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./index";
import { modelPrices, usageEvents } from "./schema";
import {
  computeCost,
  type LongContextTier,
  type ModelPrice,
  type UsageCounts,
} from "../lib/usage/pricing";

/**
 * 0047 store: usage_events writes, the model_prices cache, and the group
 * rollup the stats drawer reads. Synchronous, node-only (the app side);
 * workflow steps import this through dynamic import inside their bodies.
 */

export type UsageEvent = typeof usageEvents.$inferSelect;

/** Persist one metered unit. Idempotent on id (a retried settle
 *  re-inserts the same row — onConflictDoNothing keeps it single). */
export function recordUsageEvent(db: Db, row: typeof usageEvents.$inferInsert): void {
  db.insert(usageEvents).values(row).onConflictDoNothing().run();
}

/**
 * 0047 review fix: incremental upsert — overwrite the row in place with
 * the LATEST running totals (cost recomputed against the current price
 * row; a price fetched mid-call only improves the number). The harness
 * worker writes after every advance step, so a call cancelled at minute
 * 29 keeps its first 29 minutes of usage instead of dropping to zero.
 * Chat turns keep the insert-only path (one row, written once at end).
 */
export function upsertUsageEvent(db: Db, row: typeof usageEvents.$inferInsert): void {
  db.insert(usageEvents)
    .values(row)
    .onConflictDoUpdate({
      target: usageEvents.id,
      set: {
        inputTokens: row.inputTokens,
        cachedTokens: row.cachedTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens,
        steps: row.steps,
        toolCalls: row.toolCalls,
        costUsd: row.costUsd,
        endedAt: row.endedAt,
      },
    })
    .run();
}

// --- model_prices -----------------------------------------------------------

function parseLongContext(raw: string | null): LongContextTier[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LongContextTier[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function rowToPrice(row: typeof modelPrices.$inferSelect): ModelPrice {
  return {
    provider: row.provider,
    model: row.model,
    inputPerM: row.inputPerM,
    outputPerM: row.outputPerM,
    cacheReadPerM: row.cacheReadPerM,
    cacheWritePerM: row.cacheWritePerM,
    longContext: parseLongContext(row.longContext),
    platformFee: row.platformFee,
    source: row.source,
    fetchedAt: row.fetchedAt,
  };
}

export function getPrice(db: Db, provider: string, model: string): ModelPrice | null {
  const row = db
    .select()
    .from(modelPrices)
    .where(sql`${modelPrices.provider} = ${provider} and ${modelPrices.model} = ${model}`)
    .get();
  return row ? rowToPrice(row) : null;
}

/** Cost for captured usage against the CURRENT price row (null when no
 *  row — subscriptions never get dollars). Callers store the result. */
export function costFor(db: Db, provider: string, model: string, usage: UsageCounts): number | null {
  const price = getPrice(db, provider, model);
  return price ? computeCost(price, usage) : null;
}

/** 0051: the conversation's context usage — its LATEST chat usage
 * row's last-slice counts (the last slice's input re-sent the whole
 * conversation). Harness rows never answer a chat's context; children
 * meter their own. Null when the chat has no metered chat turns, or
 * only pre-0051 rows (all last-* null). */
export interface ContextUsageRow {
  route: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export function readContextUsage(db: Db, conversationId: string): ContextUsageRow | null {
  const rows = db
    .select({
      route: usageEvents.route,
      inputTokens: usageEvents.lastInputTokens,
      cachedTokens: usageEvents.lastCachedTokens,
      outputTokens: usageEvents.lastOutputTokens,
      reasoningTokens: usageEvents.lastReasoningTokens,
      endedAt: usageEvents.endedAt,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.conversationId, conversationId), eq(usageEvents.source, "chat")))
    .all();
  let best: (typeof rows)[number] | null = null;
  for (const row of rows) {
    // Skip pre-0051 rows entirely (null last-slice) — an older metered
    // turn is a WORSE answer than no answer.
    if (row.inputTokens == null) continue;
    if (
      best == null ||
      row.endedAt > best.endedAt ||
      (row.endedAt === best.endedAt && (row.createdAt ?? 0) > (best.createdAt ?? 0))
    ) {
      best = row;
    }
  }
  if (best == null) return null;
  return {
    route: best.route,
    inputTokens: best.inputTokens ?? 0,
    cachedTokens: best.cachedTokens ?? 0,
    outputTokens: best.outputTokens ?? 0,
    reasoningTokens: best.reasoningTokens ?? 0,
  };
}

/** Upsert price rows; `manual` rows already present are never
 *  overwritten by fetched sources (an edited calibration survives). */
export function replaceModelPrices(db: Db, source: string, prices: ModelPrice[]): void {
  const existing = db
    .select({ provider: modelPrices.provider, model: modelPrices.model, source: modelPrices.source })
    .from(modelPrices)
    .all();
  const manual = new Set(
    existing.filter((r) => r.source === "manual").map((r) => `${r.provider}:${r.model}`),
  );
  db.transaction((runner) => {
    for (const p of prices) {
      if (p.source !== "manual" && manual.has(`${p.provider}:${p.model}`)) continue;
      runner
        .insert(modelPrices)
        .values({
          provider: p.provider,
          model: p.model,
          inputPerM: p.inputPerM,
          outputPerM: p.outputPerM,
          cacheReadPerM: p.cacheReadPerM,
          cacheWritePerM: p.cacheWritePerM,
          longContext: p.longContext ? JSON.stringify(p.longContext) : null,
          platformFee: p.platformFee,
          source: p.source,
          fetchedAt: p.fetchedAt,
        })
        .onConflictDoUpdate({
          target: [modelPrices.provider, modelPrices.model],
          set: {
            inputPerM: p.inputPerM,
            outputPerM: p.outputPerM,
            cacheReadPerM: p.cacheReadPerM,
            cacheWritePerM: p.cacheWritePerM,
            longContext: p.longContext ? JSON.stringify(p.longContext) : null,
            platformFee: p.platformFee,
            source: p.source,
            fetchedAt: p.fetchedAt,
          },
        })
        .run();
    }
  });
}

export function pricesFetchedAt(db: Db, provider: string): number | null {
  const row = db
    .select({ at: sql<number>`max(${modelPrices.fetchedAt})` })
    .from(modelPrices)
    .where(eq(modelPrices.provider, provider))
    .get();
  return row?.at ?? null;
}

// --- group rollup ------------------------------------------------------------

export interface GroupUsage {
  /** Metered events only (null-cost rows excluded from dollars). */
  totalCostUsd: number | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  steps: number;
  toolCalls: number;
  /** Started → ended span summed over events (parallel children sum). */
  workMs: number;
  events: UsageEvent[];
}

export function sumGroupUsage(db: Db, conversationIds: string[]): GroupUsage {
  const empty: GroupUsage = {
    totalCostUsd: null,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    steps: 0,
    toolCalls: 0,
    workMs: 0,
    events: [],
  };
  if (conversationIds.length === 0) return empty;
  const events = db
    .select()
    .from(usageEvents)
    .where(inArray(usageEvents.conversationId, conversationIds))
    .orderBy(usageEvents.startedAt)
    .all();
  let cost: number | null = null;
  for (const e of events) {
    empty.inputTokens += e.inputTokens;
    empty.cachedTokens += e.cachedTokens;
    empty.outputTokens += e.outputTokens;
    empty.reasoningTokens += e.reasoningTokens ?? 0;
    empty.steps += e.steps;
    empty.toolCalls += e.toolCalls;
    empty.workMs += Math.max(0, e.endedAt - e.startedAt);
    if (e.costUsd !== null) cost = (cost ?? 0) + e.costUsd;
  }
  empty.events = events;
  empty.totalCostUsd = cost;
  return empty;
}
