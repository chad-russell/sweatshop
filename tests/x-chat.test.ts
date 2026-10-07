import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getHookByToken, getRun, start } from "workflow/api";
import { db } from "../db";
import {
  ensureConversation,
  listMessageTexts,
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

function conv(name: string): string {
  const id = `c_test_${name}_${Math.random().toString(36).slice(2, 8)}`;
  ensureConversation(db(), id);
  return id;
}

async function turn(conversationId: string, userText: string) {
  return start(chatTurn, [{ conversationId, userText }]);
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
    kind: "approval",
    approved,
    ...(comment ? { comment } : {}),
  });
}

/** Every part of a run's durable stream (what the reconnect route serves). */
async function readAll(runId: string): Promise<unknown[]> {
  const reader = getRun(runId).getReadable({ startIndex: 0 }).getReader();
  const parts: unknown[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
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

      // 0021: the turn records what ran it (built-in global default here).
      const rows = listMessageTexts(db(), id);
      expect(rows.find((r) => r.role === "assistant")?.metadata?.route).toEqual({
        route: { provider: "glm", model: "glm-5.3-flash" },
        layer: "global",
      });

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
    "question: a freeform ask_chad suspends on the hook and returns Chad's answer",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "question";
      const id = conv("question");

      const run = await turn(id, "please ask me a question");
      const returnValue = run.returnValue;

      await waitFor(async () => {
        try {
          return (await getHookByToken("call_ask_chad_1")) != null;
        } catch {
          return false;
        }
      }, "hook call_ask_chad_1 to exist");
      await chatApprovalHook.resume("call_ask_chad_1", {
        kind: "question",
        answer: "sqlite, obviously",
      });

      const result = await returnValue;
      expect(result.finishReason).toBe("stop");
      const history = serialized(id);
      expect(history).toContain("Chad answered: sqlite, obviously");
      expect(listPendingInputs(db(), id)).toHaveLength(0);
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

      // The durable stream spans the WHOLE turn: a slice must not close
      // it (live-caught 2026-10-07 — the browser saw only the first
      // slice and the rest of a 12-slice turn appeared only on reload).
      // Both slices are readable, and exactly one finish ends the turn.
      const parts = await readAll(run.runId);
      const types = parts.map((p) => (p as { type: string }).type);
      expect(JSON.stringify(parts)).toContain("mock-steer-saw:STEER_MARKER");
      expect(types.filter((t) => t === "model-call-start")).toHaveLength(2);
      expect(types.filter((t) => t === "finish")).toHaveLength(1);
      expect(types.at(-1)).toBe("finish");
    },
  );

  it(
    "edit-machine: a scripted edit_machine call changes the machine row (0015)",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "edit-machine";
      const { createMachine, getMachine } = await import("../db/machines");
      createMachine(db(), {
        id: "m-mock-edit",
        name: "Mock edit",
        definition: {
          workspace: "none",
          start: "draft",
          stages: {
            draft: { kind: "agent", title: "Draft", instructions: "d", next: [] },
          },
        },
      });
      const id = conv("edit_machine");

      const run = await turn(id, "add an approval step");
      const result = await run.returnValue;
      expect(result.finishReason).toBe("stop");

      // The machine row changed through the ordinary chat runtime.
      const machine = getMachine(db(), "m-mock-edit");
      expect(machine.version).toBe(2);
      expect(machine.definition.stages.approve).toMatchObject({ kind: "human", title: "Approve" });
      expect(machine.definition.stages.draft!.next).toEqual([{ to: "approve", when: "Ready" }]);

      // The tool result round-tripped into the transcript.
      const history = serialized(id);
      expect(history).toContain("mock-after:");
      expect(history).toContain("edit_machine");
    },
  );

  it(
    "create-machine: Chad approves before a machine exists; a denial creates nothing",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "create-machine";
      const { getMachine } = await import("../db/machines");
      const exists = (id: string) => {
        try {
          getMachine(db(), id);
          return true;
        } catch {
          return false;
        }
      };

      for (const [approved, machineId] of [
        [false, "m-mock-create-no"],
        [true, "m-mock-create-yes"],
      ] as const) {
        process.env.SWEATSHOP_CHAT_MOCK_MACHINE = machineId;
        const id = conv(`create_${approved}`);
        const run = await turn(id, "make me a machine");
        const token = `call_create_${machineId}`;
        await waitFor(async () => {
          try {
            return (await getHookByToken(token)) != null;
          } catch {
            return false;
          }
        }, "create_machine approval hook");
        // Suspended on the approval: Chad sees a pending ask, and nothing
        // has been written yet.
        expect(listPendingInputs(db(), id).map((p) => p.id)).toContain(token);
        expect(exists(machineId)).toBe(false);

        await chatApprovalHook.resume(token, { kind: "approval", approved });
        resolvePendingInput(db(), token, { approved });
        expect((await run.returnValue).finishReason).toBe("stop");
        expect(exists(machineId)).toBe(approved);
        expect(serialized(id)).toContain(approved ? '"ok":true' : "Chad declined to create machine");
      }
      delete process.env.SWEATSHOP_CHAT_MOCK_MACHINE;
    },
  );

  it(
    "viewing: the send's page context becomes a system note, rides as row metadata, and survives into later turns (0015)",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "viewing";
      const { listMessageTexts } = await import("../db/chat");
      const id = conv("viewing");
      const viewing: import("../lib/page-context").ViewingContext = {
        kind: "machine",
        id: "ticket",
        title: "Ticket",
        selection: "stage verify",
        path: "/machines/ticket",
      };

      // The route passes the send's context; the turn injects the note.
      const first = await start(chatTurn, [
        { conversationId: id, userText: "what about this?", viewing },
      ]);
      expect((await first.returnValue).finishReason).toBe("stop");

      // The model saw exactly the current note.
      expect(serialized(id)).toContain("mock-viewing:1");

      // The note lives on the user row as metadata — never as text — and
      // the send is persisted exactly once (the injected note shifts the
      // user message; the skip must count it — live-caught in phase 6).
      const rows = listMessageTexts(db(), id);
      const userRows = rows.filter((r) => r.role === "user" && r.text === "what about this?");
      expect(userRows).toHaveLength(1);
      expect(userRows[0]?.text).toBe("what about this?");
      expect(userRows[0]?.metadata?.viewing).toMatchObject({
        kind: "machine",
        id: "ticket",
        selection: "stage verify",
      });

      // A later turn re-injects the persisted note (history) plus its own.
      const second = await start(chatTurn, [
        { conversationId: id, userText: "and this one?", viewing: { kind: "chat", id } },
      ]);
      expect((await second.returnValue).finishReason).toBe("stop");
      expect(serialized(id)).toContain("mock-viewing:2");

      // A send with no context adds no note, and nothing note-shaped is
      // ever persisted as a message row.
      const third = await start(chatTurn, [
        { conversationId: id, userText: "plain now" },
      ]);
      await third.returnValue;
      expect(JSON.stringify(listModelMessages(db(), id))).not.toContain("[viewing]");
    },
  );

  it(
    "background harness call: the worker advances the harness, settles with its text, and wakes the chat (0022)",
    { timeout: 30_000 },
    async () => {
      // Scripted harness (two semantic steps); the wake starts a chat
      // turn, answered by the plain mock.
      process.env.SWEATSHOP_HARNESS_MOCK = "1";
      process.env.SWEATSHOP_CHAT_MOCK = "plain";
      try {
        const { projects } = await import("../db/schema");
        const { getHarnessCall } = await import("../db/harness-calls");
        const { startHarnessCall } = await import("../lib/chat/harness-call-start");
        db().insert(projects).values({ id: "p_xchat_hc", name: "HC", createdAt: 0 }).onConflictDoNothing().run();
        const id = `c_test_hc_${Math.random().toString(36).slice(2, 8)}`;
        ensureConversation(db(), id, "p_xchat_hc");

        const started = await startHarnessCall({ conversationId: id, kind: "pi", task: "say hi" });
        expect(started.ok).toBe(true);
        if (!started.ok) return;

        await waitFor(async () => getHarnessCall(db(), started.callId)?.status !== "running", "call to settle");
        const call = getHarnessCall(db(), started.callId)!;
        // It RAN: both scripted steps' text, not an empty instant "completed".
        expect(call.status).toBe("completed");
        expect(call.result).toContain("mock-harness-step:1");
        expect(call.result).toContain("mock-harness-step:2");
        // ...and woke the chat with that result.
        await waitFor(
          async () => listMessageTexts(db(), id).some((r) => r.role === "user" && r.text.startsWith("[pi finished]")),
          "the wake message",
        );
        const wake = listMessageTexts(db(), id).find((r) => r.text.startsWith("[pi finished]"))!;
        expect(wake.text).toContain("mock-harness-step:2");
      } finally {
        delete process.env.SWEATSHOP_HARNESS_MOCK;
      }
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
