import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getHookByToken, getRun, start } from "workflow/api";
import { db } from "../db";
import {
  ensureConversation,
  listModelMessages,
  listPendingInputs,
  resolvePendingInput,
} from "../db/chat";
import { chatApprovalHook } from "../workflows/chat/hooks";
import { chatTurn } from "../workflows/chat/turn";
import { startWorkflowExecutor, type WorkflowExecutor } from "./helpers/workflow-executor";

/**
 * 0010 Phase 1 spike — the new chat runtime (one WorkflowAgent run per
 * turn, sqlite as source of truth) against the scripted mock LLM
 * (workflows/chat/mock-model.ts; SWEATSHOP_CHAT_MOCK names the script,
 * double-gated on NODE_ENV=test in the model factory). Each test proves
 * one of the risks the design doc says must be answered before tearing
 * anything up:
 *
 *   full turn + history sharing    → "plain"
 *   approval hook in the tool loop → "approve"   (+ durable stream replay)
 *   steer drained between slices   → "steer"
 *   cancel                         → "hang"
 *
 * HTTP reconnect is covered live (dev server + curl) — the route replays
 * exactly the getReadable() API asserted in the "approve" test.
 */

const MODEL = "glm-5.3-flash";

function conv(name: string): string {
  const id = `c_test_${name}_${Math.random().toString(36).slice(2, 8)}`;
  ensureConversation(db(), id);
  return id;
}

async function turn(conversationId: string, userText: string) {
  return start(chatTurn, [{ conversationId, userText, modelId: MODEL }]);
}

async function waitFor(what: () => Promise<boolean>, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await what()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Resume an approval hook once the tool has durably created it. */
async function resumeWhenReady(token: string, approved: boolean, comment?: string) {
  await waitFor(async () => {
    try {
      return (await getHookByToken(token)) != null;
    } catch {
      return false;
    }
  }, `hook ${token} to exist`);
  await chatApprovalHook.resume(token, {
    approved,
    ...(comment ? { comment } : {}),
  });
}

function serialized(conversationId: string): string {
  return JSON.stringify(listModelMessages(db(), conversationId));
}

describe("0010 spike: chat turn workflow", () => {
  let executor: WorkflowExecutor;

  beforeAll(async () => {
    executor = await startWorkflowExecutor();
  }, 120_000);

  afterAll(async () => {
    await executor?.close();
  });
  it(
    "plain turn: streams, persists, and the next turn loads the first turn's history",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "plain";
      const id = conv("plain");

      const first = await turn(id, "first message");
      const result1 = await first.returnValue;
      expect(result1.finishReason).toBe("stop");

      // user row + assistant reply persisted; the reply counts the user
      // messages the model was shown.
      const after1 = listModelMessages(db(), id);
      expect(after1.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(JSON.stringify(after1[1])).toContain("mock-reply:1");

      // Second turn: history must include turn one, so the mock counts 2.
      const second = await turn(id, "second message");
      await second.returnValue;
      const after2 = serialized(id);
      expect(after2).toContain("mock-reply:2");
    },
  );

  it(
    "approval: a tool suspends on a hook mid-loop and resumes on Chad's answer",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "approve";
      const id = conv("approve");

      const run = await turn(id, "please ask me");
      const returnValue = run.returnValue;

      // The mock's first step calls ask_chad with a fixed tool call id.
      await resumeWhenReady("call_ask_chad_1", true, "go");
      // ...and the tool recorded the pending row (a STEP called from
      // the workflow-context tool execute) — the inbox's view.
      const pendingWhileSuspended = listPendingInputs(db(), id);
      expect(pendingWhileSuspended.map((p) => p.id)).toContain("call_ask_chad_1");
      resolvePendingInput(db(), "call_ask_chad_1", { approved: true });
      expect(listPendingInputs(db(), id)).toHaveLength(0);

      const result = await returnValue;
      expect(result.finishReason).toBe("stop");

      // The turn persisted the tool round-trip: the tool result text
      // (with Chad's comment) is echoed by the mock's second step.
      const history = serialized(id);
      expect(history).toContain("mock-after:");
      expect(history).toContain("Chad approved: go");

      // Durable stream replay — exactly what the reconnect route serves.
      const stream = getRun(run.runId).getReadable({ startIndex: 0 });
      const reader = stream.getReader();
      const parts: unknown[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }
      expect(JSON.stringify(parts)).toContain("ask_chad");
    },
  );

  it(
    "steer: a message queued while the turn runs is drained between slices",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "steer";
      const id = conv("steer");

      // Queue the steer row BEFORE the turn: the first prepareStep skips
      // the queue (the turn starts with exactly what it loaded), step 1's
      // tool call forces a second model step, and THAT prepareStep must
      // drain the row into the model's context.
      const { enqueueSteer } = await import("../db/chat");
      enqueueSteer(db(), id, "STEER_MARKER");

      const run = await turn(id, "begin steer test");
      const result = await run.returnValue;
      expect(result.finishReason).toBe("stop");

      const history = serialized(id);
      expect(history).toContain("STEER_MARKER"); // injected user message persisted
      expect(history).toContain("mock-steer-saw:STEER_MARKER"); // the model saw it
    },
  );

  it(
    "cancel: a hung model call cancels the run and nothing is persisted for it",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "hang";
      const id = conv("cancel");

      const run = await turn(id, "this turn will hang");
      await waitFor(async () => (await run.status) === "running", "run to start");
      await run.cancel({ cancelReason: "test cancel" });

      expect(await run.status).toBe("cancelled");
      // Cancel can land before or after the user-message step records;
      // the invariant that matters is that no assistant output from the
      // hung turn was ever persisted.
      const roles = listModelMessages(db(), id).map((m) => m.role);
      expect(roles.includes("assistant")).toBe(false);
    },
  );
});
