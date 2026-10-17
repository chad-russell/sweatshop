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
    replaceModelPrices(db(), "gloo-v2-models", [price()]);
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
      usage: { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    }).catch(() => {});

    const row = db().select().from(usageEvents).where(eq(usageEvents.id, `u_hc_${call.id}`)).get();
    expect(row).toBeTruthy();
    expect(row!.source).toBe("harness");
    expect(row!.harnessCallId).toBe(call.id);
    expect(row!.inputTokens).toBe(1_000_000);
    expect(row!.steps).toBe(2);
    expect(row!.toolCalls).toBe(2);
    expect(row!.costUsd).toBe(1);
    expect(row!.startedAt).toBe(call.createdAt);
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
