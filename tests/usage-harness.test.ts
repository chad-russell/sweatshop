import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
import { createHarnessCall } from "../db/harness-calls";
import { usageEvents } from "../db/schema";
import { replaceModelPrices } from "../db/usage";
import type { ModelPrice } from "../lib/usage/pricing";
import { harnessSettleStep } from "../workflows/chat/harness-step";

/**
 * 0047: harnessSettleStep writes u_hc_<callId> before it wakes. The wake
 * has no workflow runtime in this process, so the step throws there —
 * the row is already in sqlite. Pi looks up a price; claude/cursor stay
 * null (subscription, no invented dollars).
 */

let seq = 0;
const chatId = () => `c_usage_hc_${++seq}`;

const price = (over: Partial<ModelPrice> = {}): ModelPrice => ({
  provider: "gloo",
  model: "gloo-kimi-k3",
  inputPerM: 1,
  outputPerM: 2,
  cacheReadPerM: 0.1,
  cacheWritePerM: null,
  longContext: null,
  platformFee: 1,
  source: "gloo-v2-models",
  fetchedAt: 1,
  ...over,
});

describe("0047 harness usage capture", () => {
  it("records a priced pi call as u_hc_<callId>", async () => {
    const conversationId = chatId();
    ensureConversation(db(), conversationId, null);
    replaceModelPrices(db(), "gloo-v2-models", [price({ cacheWritePerM: 1.25 })]);
    const call = createHarnessCall(db(), { conversationId, kind: "pi", task: "meter me" });

    await harnessSettleStep({
      callId: call.id,
      conversationId,
      kind: "pi",
      status: "completed",
      text: "done",
      finalText: "done",
      toolCalls: 2,
      steps: 2,
      route: { harness: "pi", provider: "gloo", model: "gloo-kimi-k3" },
      usage: { inputTokens: 1_000_000, cachedTokens: 600_000, cacheWriteTokens: 200_000, outputTokens: 0, reasoningTokens: 0 },
    }).catch(() => {});

    const row = db().select().from(usageEvents).where(eq(usageEvents.id, `u_hc_${call.id}`)).get();
    expect(row).toBeTruthy();
    expect(row!.source).toBe("harness");
    expect(row!.harnessCallId).toBe(call.id);
    expect(row!.inputTokens).toBe(1_000_000);
    expect(row!.cacheWriteTokens).toBe(200_000);
    expect(row!.cachedTokens).toBe(600_000);
    expect(row!.steps).toBe(2);
    expect(row!.toolCalls).toBe(2);
    expect(row!.costUsd).toBe(0.51); // 0.2 fresh + 0.06 read + 0.25 write
    expect(row!.startedAt).toBe(call.createdAt);
  });

  it("records claude's reported cost with basis 'reported'", async () => {
    const conversationId = chatId();
    ensureConversation(db(), conversationId, null);
    const call = createHarnessCall(db(), { conversationId, kind: "claude", task: "reported" });

    await harnessSettleStep({
      callId: call.id,
      conversationId,
      kind: "claude",
      status: "completed",
      text: "ok",
      finalText: "ok",
      toolCalls: 1,
      steps: 1,
      route: { harness: "claude" },
      usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5, reasoningTokens: 0 },
      reportedCostUsd: 1.234,
    }).catch(() => {});

    const row = db().select().from(usageEvents).where(eq(usageEvents.id, `u_hc_${call.id}`)).get();
    expect(row!.costUsd).toBe(1.23);
    expect(row!.costBasis).toBe("reported");
  });

  it("stamps the resolved model onto a bare claude route", async () => {
    const conversationId = chatId();
    ensureConversation(db(), conversationId, null);
    const call = createHarnessCall(db(), { conversationId, kind: "claude", task: "model" });

    await harnessSettleStep({
      callId: call.id,
      conversationId,
      kind: "claude",
      status: "completed",
      text: "ok",
      finalText: "ok",
      toolCalls: 0,
      steps: 1,
      route: { harness: "claude" },
      usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5, reasoningTokens: 0 },
      model: "claude-sonnet-5-5",
    }).catch(() => {});

    const row = db().select().from(usageEvents).where(eq(usageEvents.id, `u_hc_${call.id}`)).get();
    expect(JSON.parse(row!.route)).toEqual({ harness: "claude", model: "claude-sonnet-5-5" });
  });

  it("leaves claude cost null", async () => {
    const conversationId = chatId();
    ensureConversation(db(), conversationId, null);
    const call = createHarnessCall(db(), { conversationId, kind: "claude", task: "plan" });

    await harnessSettleStep({
      callId: call.id,
      conversationId,
      kind: "claude",
      status: "completed",
      text: "done",
      finalText: "done",
      toolCalls: 1,
      steps: 1,
      route: { harness: "claude" },
      usage: { inputTokens: 500, cachedTokens: 0, outputTokens: 20, reasoningTokens: 0 },
    }).catch(() => {});

    const row = db().select().from(usageEvents).where(eq(usageEvents.id, `u_hc_${call.id}`)).get();
    expect(row!.source).toBe("harness");
    expect(row!.costUsd).toBeNull();
    expect(row!.inputTokens).toBe(500);
  });
});

describe("0047 review fix: cancelled calls keep their metering", () => {
  it("the per-step checkpoint upserts running totals, so a row survives with no settle", async () => {
    const { ensureConversation } = await import("@/db/chat");
    const { createHarnessCall, settleHarnessCall } = await import("@/db/harness-calls");
    const { db } = await import("@/db");
    const { replaceModelPrices } = await import("@/db/usage");
    const { writeHarnessUsageRow } = await import("@/workflows/chat/harness-step");

    ensureConversation(db(), "c_cancel");
    replaceModelPrices(db(), "gloo-v2-models", [
      { provider: "gloo", model: "gloo-x", inputPerM: 1, outputPerM: 2, cacheReadPerM: null, cacheWritePerM: null, longContext: null, platformFee: 1, source: "gloo-v2-models", fetchedAt: 1 },
    ]);
    createHarnessCall(db(), { conversationId: "c_cancel", kind: "pi", task: "long call" }, 1000);

    // step 1 checkpoint (as the advance step does)
    await writeHarnessUsageRow("hc_canceltest", "c_cancel", { harness: "pi", provider: "gloo", model: "gloo-x" }, {
      usage: { inputTokens: 500_000, cachedTokens: 0, cacheWriteTokens: 100_000, outputTokens: 50_000 },
      steps: 1,
      toolCalls: 4,
    });
    // step 2 checkpoint — same row, grown totals
    await writeHarnessUsageRow("hc_canceltest", "c_cancel", { harness: "pi", provider: "gloo", model: "gloo-x" }, {
      usage: { inputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 200_000, outputTokens: 100_000 },
      steps: 2,
      toolCalls: 9,
    });

    // a racing cancel settles the call — the settle usage write never runs
    settleHarnessCall(db(), "hc_canceltest", { status: "cancelled" });

    const { sumGroupUsage } = await import("@/db/usage");
    const group = sumGroupUsage(db(), ["c_cancel"]);
    expect(group.events).toHaveLength(1);
    expect(group.events[0]!.steps).toBe(2);
    expect(group.events[0]!.toolCalls).toBe(9);
    expect(group.events[0]!.inputTokens).toBe(1_000_000);
    expect(group.events[0]!.cacheWriteTokens).toBe(200_000);
    // 1M*1 + 0.1M*2 = $1.20
    expect(group.events[0]!.costUsd).toBeCloseTo(1.2, 10);
  });
});
