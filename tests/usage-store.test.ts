import { describe, expect, it } from "vitest";
import { db as getDb, type Db } from "@/db";
import { ensureConversation } from "@/db/chat";
import {
  costFor,
  getPrice,
  pricesFetchedAt,
  readContextUsage,
  recordUsageEvent,
  replaceModelPrices,
  sumGroupUsage,
} from "@/db/usage";
import { computeCost, type ModelPrice } from "@/lib/usage/pricing";

const db: Db = getDb();

const price = (provider: string, model: string, over: Partial<ModelPrice> = {}): ModelPrice => ({
  provider,
  model,
  inputPerM: 2,
  outputPerM: 10,
  cacheReadPerM: 0.2,
  cacheWritePerM: null,
  longContext: null,
  platformFee: 1,
  source: "gloo-v2-models",
  fetchedAt: 1_000,
  ...over,
});

describe("0047 model_prices store", () => {
  it("upserts fetched rows and keeps manual rows on conflict", () => {
    replaceModelPrices(db, "manual", [price("gloo", "edited", { inputPerM: 99, source: "manual" })]);
    // a fetched source tries to overwrite the manual row
    replaceModelPrices(db, "gloo-v2-models", [price("gloo", "edited", { inputPerM: 1 })]);
    expect(getPrice(db, "gloo", "edited")!.inputPerM).toBe(99);
    // and inserts a fresh row fine
    expect(getPrice(db, "gloo", "fresh") ?? null).toBeNull();
    replaceModelPrices(db, "gloo-v2-models", [price("gloo", "fresh")]);
    expect(getPrice(db, "gloo", "fresh")!.inputPerM).toBe(2);
  });

  it("round-trips long-context tiers through JSON", () => {
    replaceModelPrices(db, "gloo-v2-models", [
      price("gloo", "tiered", {
        longContext: [{ minPromptTokens: 200_000, inputPerM: 4, outputPerM: 15, cacheReadPerM: 0.4 }],
      }),
    ]);
    expect(getPrice(db, "gloo", "tiered")!.longContext).toEqual([
      { minPromptTokens: 200_000, inputPerM: 4, outputPerM: 15, cacheReadPerM: 0.4 },
    ]);
  });

  it("costFor computes against the stored row; null when absent", () => {
    replaceModelPrices(db, "gloo-v2-models", [price("gloo", "costed")]);
    expect(costFor(db, "gloo", "costed", { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 })).toBe(2);
    expect(costFor(db, "gloo", "absent", { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 })).toBeNull();
  });

  it("pricesFetchedAt reads the max fetched_at for a provider", () => {
    replaceModelPrices(db, "gloo-v2-models", [price("gloo", "at-a", { fetchedAt: 5 }), price("gloo", "at-b", { fetchedAt: 9 })]);
    expect(pricesFetchedAt(db, "gloo")).toBeGreaterThanOrEqual(9);
  });
});

describe("0047 usage_events store", () => {
  it("records events idempotently and rolls up a group", () => {
    ensureConversation(db, "c_rollup");
    ensureConversation(db, "c_child", null);
    const row = {
      id: "u_c_rollup_2",
      conversationId: "c_rollup",
      source: "chat" as const,
      harnessCallId: null,
      route: "{}",
      inputTokens: 1_000_000,
      cachedTokens: 500_000,
      outputTokens: 200_000,
      reasoningTokens: 20_000,
      steps: 3,
      toolCalls: 5,
      costUsd: 3.12,
      startedAt: 1_000,
      endedAt: 61_000,
      createdAt: 61_000,
    };
    recordUsageEvent(db, row);
    recordUsageEvent(db, row); // retried settle — single row
    recordUsageEvent(db, {
      ...row,
      id: "u_hc_callx",
      conversationId: "c_child",
      source: "harness",
      harnessCallId: "hc_callx",
      costUsd: null, // plan surface
      startedAt: 200_000,
      endedAt: 260_000,
    });

    const group = sumGroupUsage(db, ["c_rollup", "c_child"]);
    expect(group.events).toHaveLength(2);
    expect(group.inputTokens).toBe(2_000_000);
    expect(group.cachedTokens).toBe(1_000_000);
    expect(group.outputTokens).toBe(400_000);
    expect(group.steps).toBe(6);
    expect(group.toolCalls).toBe(10);
    expect(group.workMs).toBe(120_000);
    expect(group.totalCostUsd).toBeCloseTo(3.12, 10);

    // events for conversations outside the group never leak in
    expect(sumGroupUsage(db, ["c_child"]).events).toHaveLength(1);
  });

  it("totalCostUsd stays null when every event is unmetered", () => {
    ensureConversation(db, "c_plan");
    recordUsageEvent(db, {
      id: "u_c_plan_2",
      conversationId: "c_plan",
      source: "chat",
      harnessCallId: null,
      route: "{}",
      inputTokens: 10,
      cachedTokens: 0,
      outputTokens: 5,
      reasoningTokens: null,
      steps: 1,
      toolCalls: 0,
      costUsd: null,
      startedAt: 0,
      endedAt: 1,
      createdAt: 1,
    });
    expect(sumGroupUsage(db, ["c_plan"]).totalCostUsd).toBeNull();
  });

  it("usage rows cascade with their conversation", () => {
    ensureConversation(db, "c_gone");
    recordUsageEvent(db, {
      id: "u_c_gone_2",
      conversationId: "c_gone",
      source: "chat",
      harnessCallId: null,
      route: "{}",
      inputTokens: 1,
      cachedTokens: 0,
      outputTokens: 1,
      reasoningTokens: null,
      steps: 1,
      toolCalls: 0,
      costUsd: null,
      startedAt: 0,
      endedAt: 1,
      createdAt: 1,
    });
    // direct delete exercises the FK cascade
    const sqlite = (db as unknown as { $client: { exec: (sql: string) => void } }).$client;
    sqlite.exec("PRAGMA foreign_keys = ON; DELETE FROM conversations WHERE id = 'c_gone'");
    expect(sumGroupUsage(db, ["c_gone"]).events).toHaveLength(0);
  });
});

describe("0047 computeCost null-price guard", () => {
  it("a missing price row never invents dollars", () => {
    // computeCost is only called with a row; costFor is the guard.
    expect(computeCost(price("glm", "plan-model", { source: "manual" }), { inputTokens: 1e6, cachedTokens: 0, outputTokens: 1e6 })).not.toBeNull();
  });
});

describe("0051 readContextUsage", () => {
  it("returns the conversation's latest metered chat row's last-slice counts", () => {
    ensureConversation(db, "c_ctx");
    recordUsageEvent(db, {
      id: "u_c_ctx_0",
      conversationId: "c_ctx",
      source: "chat",
      harnessCallId: null,
      route: JSON.stringify({ provider: "glm", model: "glm-5.3-flash" }),
      inputTokens: 900,
      cachedTokens: 0,
      outputTokens: 100,
      reasoningTokens: 0,
      lastInputTokens: 900,
      lastCachedTokens: 0,
      lastOutputTokens: 100,
      lastReasoningTokens: 0,
      steps: 1,
      toolCalls: 0,
      costUsd: null,
      startedAt: 1_000,
      endedAt: 2_000,
      createdAt: 2_000,
    });
    recordUsageEvent(db, {
      id: "u_c_ctx_2",
      conversationId: "c_ctx",
      source: "chat",
      harnessCallId: null,
      route: JSON.stringify({ provider: "glm", model: "glm-5.3-flash" }),
      inputTokens: 3_000,
      cachedTokens: 500,
      outputTokens: 400,
      reasoningTokens: 40,
      lastInputTokens: 1_500,
      lastCachedTokens: 500,
      lastOutputTokens: 300,
      lastReasoningTokens: 30,
      steps: 2,
      toolCalls: 1,
      costUsd: null,
      startedAt: 3_000,
      endedAt: 4_000,
      createdAt: 4_000,
    });
    const ctx = readContextUsage(db, "c_ctx");
    expect(ctx).not.toBeNull();
    expect(ctx!.inputTokens).toBe(1_500);
    expect(ctx!.outputTokens).toBe(300);
    expect(JSON.parse(ctx!.route)).toMatchObject({ model: "glm-5.3-flash" });
  });

  it("skips pre-0051 rows (null last-slice) — no answer beats a stale one", () => {
    ensureConversation(db, "c_ctx_old");
    recordUsageEvent(db, {
      id: "u_c_ctx_old_0",
      conversationId: "c_ctx_old",
      source: "chat",
      harnessCallId: null,
      route: "{}",
      inputTokens: 5_000,
      cachedTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
      steps: 1,
      toolCalls: 0,
      costUsd: null,
      startedAt: 1,
      endedAt: 2,
      createdAt: 2,
    });
    expect(readContextUsage(db, "c_ctx_old")).toBeNull();
  });

  it("never answers from a harness row or another conversation", () => {
    ensureConversation(db, "c_ctx_h", null);
    recordUsageEvent(db, {
      id: "u_hc_ctxonly",
      conversationId: "c_ctx_h",
      source: "harness",
      harnessCallId: "hc_ctxonly",
      route: "{}",
      inputTokens: 1,
      cachedTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      lastInputTokens: 1,
      lastCachedTokens: 0,
      lastOutputTokens: 1,
      lastReasoningTokens: 0,
      steps: 1,
      toolCalls: 0,
      costUsd: null,
      startedAt: 1,
      endedAt: 2,
      createdAt: 2,
    });
    expect(readContextUsage(db, "c_ctx_h")).toBeNull();
    expect(readContextUsage(db, "c_nothing")).toBeNull();
  });
});
