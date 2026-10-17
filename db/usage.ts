import { eq, inArray, sql } from "drizzle-orm";
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
