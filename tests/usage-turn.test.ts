import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
import { usageEvents } from "../db/schema";
import { chatTurn } from "../workflows/chat/turn";
import { startWorkflowExecutor, type WorkflowExecutor } from "./helpers/workflow-executor";

/**
 * 0047: a plain mock turn writes one usage_events row. The mock's finish
 * part carries V4 usage (100 in / 50 out / 10 reasoning); the turn sums
 * that into the row. Cost stays null — the built-in route is GLM, which
 * has no price row.
 */

// One executor for the whole file: the local world's queue transport
// targets a single WORKFLOW_LOCAL_BASE_URL — a second executor
// repoints it and strands the first's queue deliveries.
let executor: WorkflowExecutor;
beforeAll(async () => {
  executor = await startWorkflowExecutor();
}, 120_000);
afterAll(async () => {
  await executor?.close();
});

describe("0047 chat-turn usage capture", () => {
  it(
    "records one chat usage row with the mock's token counts",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "plain";
      const id = `c_test_usage_${Math.random().toString(36).slice(2, 8)}`;
      ensureConversation(db(), id);

      const run = await start(chatTurn, [{ conversationId: id, userText: "hello" }]);
      const result = await run.returnValue;
      expect(result.finishReason).toBe("stop");

      const rows = db().select().from(usageEvents).where(eq(usageEvents.conversationId, id)).all();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.source).toBe("chat");
      expect(row.id.startsWith(`u_${id}_`)).toBe(true);
      expect(row.steps).toBeGreaterThanOrEqual(1);
      expect(row.inputTokens).toBe(100);
      expect(row.outputTokens).toBe(50);
      expect(row.cachedTokens).toBe(0);
      expect(row.reasoningTokens).toBe(10);
      expect(row.costUsd).toBeNull();
      expect(JSON.parse(row.route)).toMatchObject({ provider: "glm", model: "glm-5.3-flash" });
      expect(row.endedAt).toBeGreaterThanOrEqual(row.startedAt);
    },
  );
});

describe("0051 last-slice capture", () => {
  it(
    "a single-slice turn records its slice as the last slice",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "plain";
      const id = `c_test_lastsl_${Math.random().toString(36).slice(2, 8)}`;
      ensureConversation(db(), id);

      const run = await start(chatTurn, [{ conversationId: id, userText: "hello" }]);
      await run.returnValue;

      const row = db().select().from(usageEvents).where(eq(usageEvents.conversationId, id)).get();
      expect(row).toBeDefined();
      // The mock's single slice IS the last slice: same counts.
      expect(row!.lastInputTokens).toBe(100);
      expect(row!.lastOutputTokens).toBe(50);
      expect(row!.lastReasoningTokens).toBe(10);
      expect(row!.inputTokens).toBe(100); // turn sum = the one slice
    },
  );

  it(
    "a multi-slice turn records the LAST slice, not the sum",
    { timeout: 60_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "steer";
      const id = `c_test_lastmulti_${Math.random().toString(36).slice(2, 8)}`;
      ensureConversation(db(), id);

      // "steer" needs a queued row to drain between slices; enqueue before start.
      const { appendMessages } = await import("../db/chat");
      appendMessages(db(), id, [
        {
          id: `sq_${id}_drain`,
          role: "user",
          text: "STEER_MARKER",
          modelMessage: { role: "user", content: "STEER_MARKER" },
        },
      ]);

      const run = await start(chatTurn, [{ conversationId: id, userText: "begin" }]);
      await run.returnValue;

      const rows = db().select().from(usageEvents).where(eq(usageEvents.conversationId, id)).all();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row!.steps).toBe(2); // tool call, then the steered text slice
      // Every mock slice reports 100/50/10; with N=2 slices the turn SUM
      // is 200/100/20 but the LAST slice stays 100/50/10.
      expect(row!.inputTokens).toBe(200);
      expect(row!.outputTokens).toBe(100);
      expect(row!.lastInputTokens).toBe(100);
      expect(row!.lastOutputTokens).toBe(50);
      expect(row!.lastReasoningTokens).toBe(10);
    },
  );
});
