import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { getRun, start } from "workflow/api";
import { db } from "../db";
import { ensureConversation, getActiveStreamCursor, listModelMessages, setActiveRun } from "../db/chat";
import { chatTurn } from "../workflows/chat/turn";
import { startWorkflowExecutor, type WorkflowExecutor } from "./helpers/workflow-executor";

/**
 * 0077: the persisted cursor sits on a slice boundary — the journal
 * before it ends with the previous slice's finish-step/start-step, and
 * a stream resumed from it opens with the next slice's reset-step, so
 * the UI transform never sees an orphan delta or a re-sent tool result.
 */
describe("0077 resume from cursor", () => {
  let executor: WorkflowExecutor;
  beforeAll(async () => {
    executor = await startWorkflowExecutor();
  }, 120_000);
  afterAll(async () => {
    await executor?.close();
  });

  it("resumes at a clean slice boundary", { timeout: 30_000 }, async () => {
    process.env.SWEATSHOP_CHAT_MOCK = "loop";
    const id = `c_resume_${Math.random().toString(36).slice(2, 8)}`;
    ensureConversation(db(), id);
    const run = await start(chatTurn, [{ conversationId: id, userText: "go" }]);
    setActiveRun(db(), id, run.runId);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (listModelMessages(db(), id).filter((m) => m.role === "assistant").length >= 2 && getActiveStreamCursor(db(), id) != null) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const cursor = getActiveStreamCursor(db(), id)!;
    const raw: unknown[] = [];
    const ui: { type: string }[] = [];
    const reader = getRun(run.runId).getReadable({ startIndex: cursor }).getReader();
    const rawAll: unknown[] = [];
    const t0 = Date.now();
    while (raw.length < 12 && Date.now() - t0 < 3000) {
      const { value, done } = await reader.read();
      if (done) break;
      raw.push(value);
    }
    reader.releaseLock();
    const r2 = getRun(run.runId).getReadable({ startIndex: 0 }).getReader();
    while (rawAll.length < cursor + 2) {
      const { value, done } = await r2.read();
      if (done) break;
      rawAll.push(value);
    }
    r2.releaseLock();
    const ts = new TransformStream();
    void (async () => {
      const w = ts.writable.getWriter();
      for (const p of raw) await w.write(p);
      await w.close();
    })();
    const out = ts.readable.pipeThrough(createModelCallToUIChunkTransform()).getReader();
    for (;;) {
      const { value, done } = await out.read();
      if (done) break;
      ui.push(value);
    }
    const types = (xs: unknown[]) => xs.map((p) => (p as { type: string }).type);
    await run.cancel({ cancelReason: "test cleanup" });
    expect(cursor).toBeGreaterThan(0);
    expect(types(rawAll.slice(cursor - 2, cursor))).toEqual(["finish-step", "start-step"]);
    expect(types(raw)[0]).toBe("reset-step");
    expect(ui.slice(0, 3).map((c) => c.type)).toEqual(["start", "start-step", "reset-step"]);
    // nothing persisted before the cursor is re-sent
    expect(ui.filter((c) => c.type === "tool-output-available").length).toBeLessThanOrEqual(
      types(raw).filter((t) => t === "tool-result").length,
    );
  });
});
