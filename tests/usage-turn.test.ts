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

describe("0047 chat-turn usage capture", () => {
  let executor: WorkflowExecutor;

  beforeAll(async () => {
    executor = await startWorkflowExecutor();
  }, 120_000);

  afterAll(async () => {
    await executor?.close();
  });

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
