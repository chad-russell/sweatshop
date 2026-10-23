import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { db } from "../db";
import { ensureConversation, listMessageTexts, setActiveRun } from "../db/chat";
import { chatTurn } from "../workflows/chat/turn";
import { startWorkflowExecutor, type WorkflowExecutor } from "./helpers/workflow-executor";

/**
 * 0082: the repetition guard — against the real workflow executor (the
 * scripted mock LLM; no real model call), driving `chatTurn` directly
 * like tests/stream-cursor-turn.test.ts.
 *
 * RCA this guards against: a start_thread child ran `npm run …` (no
 * package.json in its sandbox cwd) ~200 times, getting the identical
 * ENOENT result every time, and burned its whole step budget never
 * noticing. The guard fires a runtime note (a runEvent-tagged user row,
 * rendered as a chip) the 3rd time ANY tool call repeats its exact
 * (name, input, result).
 */

function conv(name: string): string {
  const id = `c_loopguard_${name}_${Math.random().toString(36).slice(2, 8)}`;
  ensureConversation(db(), id);
  return id;
}

async function waitFor(what: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await what()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function loopRows(id: string) {
  return listMessageTexts(db(), id).filter((m) => m.role === "user" && m.metadata?.runEvent?.kind === "loop");
}

function assistantCount(id: string): number {
  return listMessageTexts(db(), id).filter((m) => m.role === "assistant").length;
}

describe("0082 loop guard", () => {
  let executor: WorkflowExecutor;

  beforeAll(async () => {
    executor = await startWorkflowExecutor();
  }, 120_000);

  afterAll(async () => {
    await executor?.close();
  });

  it(
    "fires once the same tool call repeats its exact input and result a 3rd time",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "repeat";
      const id = conv("fires");

      const run = await start(chatTurn, [{ conversationId: id, userText: "go" }]);
      setActiveRun(db(), id, run.runId);

      await waitFor(() => loopRows(id).length >= 1, "the loop guard row to land");
      const rows = loopRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.text).toContain("[loop guard]");
      expect(rows[0]?.text).toContain("note");
      expect(rows[0]?.text).toContain("3 times");

      // The scripted model stops as soon as it sees the guard's own note
      // (mock-model.ts's "repeat" script) — the turn settles on its own.
      const ret = await run.returnValue;
      expect(ret.finishReason).toBe("stop");
      // Only ever fires once per signature per turn (count 3, not again
      // at 4+) — the mock stops calling after it sees the note, so a
      // second firing would mean the guard re-triggered on its own note.
      expect(loopRows(id)).toHaveLength(1);
    },
  );

  it(
    "never fires when every call's input differs",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "loop";
      const id = conv("distinct");

      const run = await start(chatTurn, [{ conversationId: id, userText: "go" }]);
      setActiveRun(db(), id, run.runId);

      await waitFor(() => assistantCount(id) >= 4, "several distinct-input slices to land");
      expect(loopRows(id)).toHaveLength(0);

      // The "loop" script never stops on its own — cancel rather than
      // let it run out its full step budget (same cleanup as
      // stream-cursor-turn.test.ts's own use of this script).
      await run.cancel({ cancelReason: "test cleanup" });
      expect(await run.status).toBe("cancelled");
      expect(loopRows(id)).toHaveLength(0);
    },
  );
});
