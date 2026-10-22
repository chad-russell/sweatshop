import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { db } from "../db";
import {
  enqueueSteer,
  ensureConversation,
  getActiveRun,
  getActiveStreamCursor,
  listModelMessages,
  setActiveRun,
} from "../db/chat";
import { chatTurn } from "../workflows/chat/turn";
import { startWorkflowExecutor, type WorkflowExecutor } from "./helpers/workflow-executor";

/**
 * 0077: `persistTurn`'s own resume-cursor write/clear, end to end against
 * the real workflow executor (the scripted mock LLM; no real model
 * call). Store-level semantics of the column itself (setActiveRun,
 * clearActiveRunIfMatches) are covered in stream-cursor.test.ts.
 */

function conv(name: string): string {
  const id = `c_cursor_${name}_${Math.random().toString(36).slice(2, 8)}`;
  ensureConversation(db(), id);
  return id;
}

async function waitFor(what: () => Promise<boolean>, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await what()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function assistantCount(id: string): number {
  return listModelMessages(db(), id).filter((m) => m.role === "assistant").length;
}

describe("0077 chat-turn resume cursor", () => {
  let executor: WorkflowExecutor;

  beforeAll(async () => {
    executor = await startWorkflowExecutor();
  }, 120_000);

  afterAll(async () => {
    await executor?.close();
  });

  it(
    "advances slice by slice while the turn runs (a turn that never stops calling tools)",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "loop";
      const id = conv("advances");

      const run = await start(chatTurn, [{ conversationId: id, userText: "go" }]);
      // Driving chatTurn directly (like x-chat.test.ts) skips the app's
      // own `startChatTurn`, which is what actually stamps
      // `active_run_id` outside the workflow — reproduce that bookkeeping
      // so `getActiveRun`/the final clear are meaningful to assert on.
      setActiveRun(db(), id, run.runId);

      // `setActiveRun` above races the workflow's own first non-final
      // persist (it also nulls the cursor, 0077's "starting a run resets
      // any cursor" rule) — wait for a slice's write to land AFTER it,
      // rather than asserting on whichever one happened to run first.
      await waitFor(
        async () => assistantCount(id) >= 1 && getActiveStreamCursor(db(), id) != null,
        "a slice to persist its cursor",
      );
      expect(getActiveRun(db(), id)).toBe(run.runId);
      const firstCursor = getActiveStreamCursor(db(), id);
      expect(firstCursor as number).toBeGreaterThan(0);

      await waitFor(async () => assistantCount(id) >= 3, "more slices to persist");
      const laterCursor = getActiveStreamCursor(db(), id);
      expect(laterCursor as number).toBeGreaterThan(firstCursor as number);

      // The turn never stops on its own (the "loop" script) — cancel it
      // rather than let it run out its full step budget.
      await run.cancel({ cancelReason: "test cleanup" });
      expect(await run.status).toBe("cancelled");
    },
  );

  it(
    "clears alongside active_run_id once a multi-slice turn settles",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "steer";
      const id = conv("clears");
      // Mirrors x-chat.test.ts's "steer" turn: slice 1's tool call forces
      // a second slice, so persistTurn writes a cursor at least once
      // before the final persist clears it.
      enqueueSteer(db(), id, "STEER_MARKER");

      const run = await start(chatTurn, [{ conversationId: id, userText: "begin" }]);
      const result = await run.returnValue;
      expect(result.finishReason).toBe("stop");

      expect(getActiveRun(db(), id)).toBeNull();
      expect(getActiveStreamCursor(db(), id)).toBeNull();
    },
  );
});
