import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { GET } from "@/app/api/x/stats/[conversationId]/route";
import { db } from "@/db";
import { ensureConversation } from "@/db/chat";
import { createHarnessCall } from "@/db/harness-calls";
import { conversations, harnessCalls, messages, pendingInputs } from "@/db/schema";
import { recordUsageEvent } from "@/db/usage";

function event(
  over: Partial<Parameters<typeof recordUsageEvent>[1]> & { id: string; conversationId: string },
) {
  recordUsageEvent(db(), {
    source: "chat",
    harnessCallId: null,
    route: "{}",
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    steps: 1,
    toolCalls: 0,
    costUsd: null,
    startedAt: 2_000,
    endedAt: 3_000,
    createdAt: 3_000,
    ...over,
  });
}

describe("0047 GET /api/x/stats", () => {
  it("rolls up the group: totals, models, children, wait, and touches", async () => {
    ensureConversation(db(), "c_stats_root");
    ensureConversation(db(), "c_stats_child");
    db().update(conversations).set({ title: "Root ticket", createdAt: 1_000, updatedAt: 8_000 }).where(eq(conversations.id, "c_stats_root")).run();
    db()
      .update(conversations)
      .set({ title: "Child thread", parentConversationId: "c_stats_root", createdAt: 1_500, updatedAt: 9_000 })
      .where(eq(conversations.id, "c_stats_child"))
      .run();

    db()
      .insert(messages)
      .values([
        { id: "m_stats_1", conversationId: "c_stats_root", role: "user", text: "hi", at: 1 },
        {
          id: "m_stats_2",
          conversationId: "c_stats_root",
          role: "user",
          text: "wake",
          metadata: JSON.stringify({ runEvent: { kind: "harness", id: "hc_x" } }),
          at: 2,
        },
        { id: "m_stats_3", conversationId: "c_stats_child", role: "user", text: "child", at: 3 },
      ])
      .run();
    db()
      .insert(pendingInputs)
      .values([
        {
          id: "p_stats_1",
          conversationId: "c_stats_root",
          kind: "approval",
          question: "ok?",
          createdAt: 1_000,
          resolvedAt: 4_000,
        },
        {
          id: "p_stats_2",
          conversationId: "c_stats_child",
          kind: "question",
          question: "still open",
          createdAt: 1_000,
          resolvedAt: null,
        },
      ])
      .run();

    event({
      id: "u_c_stats_root_1",
      conversationId: "c_stats_root",
      route: JSON.stringify({ provider: "gloo", model: "gloo-kimi-k3" }),
      inputTokens: 1_000,
      cachedTokens: 250,
      outputTokens: 100,
      reasoningTokens: 10,
      steps: 2,
      toolCalls: 1,
      costUsd: 1.5,
      startedAt: 2_000,
      endedAt: 5_000,
    });
    event({
      id: "u_c_stats_child_1",
      conversationId: "c_stats_child",
      route: JSON.stringify({ provider: "glm", model: "glm-5.3-flash" }),
      inputTokens: 400,
      outputTokens: 50,
      steps: 1,
      costUsd: null,
      startedAt: 6_000,
      endedAt: 7_000,
    });

    const call = createHarnessCall(db(), {
      conversationId: "c_stats_child",
      kind: "claude",
      task: "Review the diff\nand the rest",
    });
    db()
      .update(harnessCalls)
      .set({ settledAt: call.createdAt + 5_000, status: "completed" })
      .where(eq(harnessCalls.id, call.id))
      .run();
    event({
      id: `u_hc_${call.id}`,
      conversationId: "c_stats_child",
      source: "harness",
      harnessCallId: call.id,
      route: JSON.stringify({ harness: "claude" }),
      inputTokens: 200,
      outputTokens: 80,
      steps: 3,
      toolCalls: 4,
      costUsd: null,
      startedAt: 6_000,
      endedAt: 6_500,
    });
    // 0050: a codex call buckets under its own harness key, labelled
    // "Codex" — subscription, no invented dollars.
    const codexCall = createHarnessCall(db(), {
      conversationId: "c_stats_child",
      kind: "codex",
      task: "Codex pass",
    });
    event({
      id: `u_hc_${codexCall.id}`,
      conversationId: "c_stats_child",
      source: "harness",
      harnessCallId: codexCall.id,
      route: JSON.stringify({ harness: "codex", model: "gpt-5.5", effort: "high" }),
      inputTokens: 10,
      outputTokens: 5,
      steps: 1,
      toolCalls: 1,
      costUsd: null,
      startedAt: 7_000,
      endedAt: 7_100,
    });

    const res = await GET(new Request("http://localhost/api/x/stats/c_stats_child"), {
      params: Promise.resolve({ conversationId: "c_stats_child" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.rootId).toBe("c_stats_root");
    expect(body.conversationIds).toEqual(expect.arrayContaining(["c_stats_root", "c_stats_child"]));
    expect(body.totals).toMatchObject({
      costUsd: 1.5,
      inputTokens: 1_610,
      cachedTokens: 250,
      outputTokens: 235,
      reasoningTokens: 10,
      steps: 7,
      toolCalls: 6,
      workMs: 4_600,
    });
    expect(body.wallMs).toBe(8_000);
    expect(body.waitMs).toBe(3_000);
    expect(body.medianWaitMs).toBe(3_000);
    expect(body.touches).toBe(2);
    expect(body.cacheHitRate).toBeCloseTo(250 / 1_610);

    const gloo = body.byModel.find((row: { key: string }) => row.key === "gloo/gloo-kimi-k3");
    expect(gloo).toMatchObject({
      label: "Gloo Kimi K3",
      provider: "gloo",
      model: "gloo-kimi-k3",
      isHarness: false,
      costUsd: 1.5,
      inputTokens: 1_000,
      cachedTokens: 250,
      events: 1,
    });
    const glm = body.byModel.find((row: { key: string }) => row.key === "glm/glm-5.3-flash");
    expect(glm).toMatchObject({ label: "GLM (Z.AI) GLM 5.3 Flash", isHarness: false, costUsd: null });
    const claude = body.byModel.find((row: { key: string }) => row.key === "claude");
    expect(claude).toMatchObject({ label: "Claude", isHarness: true, costUsd: null, steps: 3, toolCalls: 4 });
    const codex = body.byModel.find((row: { key: string }) => row.key === "codex");
    expect(codex).toMatchObject({ label: "Codex", isHarness: true, costUsd: null, steps: 1, toolCalls: 1 });

    const childChat = body.byChild.find(
      (row: { kind: string; conversationId: string }) => row.kind === "conversation" && row.conversationId === "c_stats_child",
    );
    expect(childChat).toMatchObject({
      title: "Child thread",
      costUsd: null,
      inputTokens: 400,
      outputTokens: 50,
      workMs: 1_000,
      steps: 1,
      href: "/c/c_stats_child",
    });
    const harness = body.byChild.find((row: { kind: string }) => row.kind === "harness");
    expect(harness).toMatchObject({
      title: "Review the diff",
      conversationId: "c_stats_child",
      costUsd: null,
      inputTokens: 200,
      outputTokens: 80,
      workMs: 5_000,
      steps: 3,
      href: `/h/claude/c_stats_child/${call.id}`,
    });
  });

  it("404s an unknown conversation", async () => {
    const res = await GET(new Request("http://localhost/api/x/stats/missing"), {
      params: Promise.resolve({ conversationId: "missing" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not-found" });
  });
});
