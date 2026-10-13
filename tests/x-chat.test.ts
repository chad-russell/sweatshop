import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { eq } from "drizzle-orm";
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
    "create-pr: Chad approves before the host is hit; a denial opens nothing (0034 A)",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "create-pr";
      const { createProject } = await import("../db/projects");
      const { conversations, gitCredentials, messages, pendingInputs, projectRepos, projects, steerQueue } =
        await import("../db/schema");

      // A local forgejo stub: createPR POSTs here on approval. Nothing
      // may reach it before Chad answers.
      const requests: { path: string; body: { head?: string } | null }[] = [];
      const server = http.createServer((req, res) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
          requests.push({ path: req.url ?? "", body: data ? JSON.parse(data) : null });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ html_url: "http://git.test/chad/r/pulls/9", number: 9 }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as import("node:net").AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        for (const answerWith of ["deny", "revise", "approve"] as const) {
          const approved = answerWith === "approve";
          const pid = `prgate-${answerWith}-${Math.random().toString(36).slice(2, 6)}`;
          expect(createProject(db(), {
            id: pid,
            name: "PR gate",
            repos: [{ name: "r", url: `${baseUrl}/chad/r` }],
          }).ok).toBe(true);
          const credId = `cred-${pid}`;
          db().insert(gitCredentials).values({
            id: credId, kind: "forgejo", label: "test", username: "chad",
            secret: "s", baseUrl, createdAt: Date.now(),
          }).run();
          const id = `c_test_prgate_${Math.random().toString(36).slice(2, 8)}`;
          ensureConversation(db(), id, pid);

          const before = requests.length;
          const run = await turn(id, "open the pr");
          await waitFor(async () => {
            try {
              return (await getHookByToken("call_pr_1")) != null;
            } catch {
              return false;
            }
          }, "create_pr approval hook");
          // Suspended on the approval: the card exists, the host untouched.
          expect(listPendingInputs(db(), id).map((p) => p.id)).toContain("call_pr_1");
          expect(requests.length).toBe(before);

          if (answerWith === "revise") {
            // 0037: typing while the PR waits = a revise, same turn.
            const { answerPendingWithText } = await import("../lib/chat/answer-pending");
            expect(await answerPendingWithText(id, "use the 896px cap")).toEqual({
              toolCallId: "call_pr_1",
              kind: "approval",
            });
          } else {
            await chatApprovalHook.resume("call_pr_1", { kind: "approval", approved });
            resolvePendingInput(db(), "call_pr_1", { approved });
          }
          expect((await run.returnValue).finishReason).toBe("stop");
          expect(listPendingInputs(db(), id)).toEqual([]);

          if (answerWith === "revise") {
            expect(requests.length).toBe(before);
            expect(serialized(id)).toContain("changes-requested");
            expect(serialized(id)).toContain("use the 896px cap");
          } else if (approved) {
            expect(requests.length).toBe(before + 1);
            expect(requests.at(-1)?.path).toBe("/api/v1/repos/chad/r/pulls");
            expect(requests.at(-1)?.body?.head).toBe("feat/trial");
            expect(serialized(id)).toContain("pulls/9");
          } else {
            expect(requests.length).toBe(before);
            expect(serialized(id)).toContain("Chad declined the PR");
          }
          db().delete(messages).where(eq(messages.conversationId, id)).run();
          db().delete(pendingInputs).where(eq(pendingInputs.conversationId, id)).run();
          db().delete(steerQueue).where(eq(steerQueue.conversationId, id)).run();
          db().delete(conversations).where(eq(conversations.id, id)).run();
          db().delete(gitCredentials).where(eq(gitCredentials.id, credId)).run();
          db().delete(projectRepos).where(eq(projectRepos.projectId, pid)).run();
          db().delete(projects).where(eq(projects.id, pid)).run();
        }
      } finally {
        server.close();
      }
    },
  );

  it(
    "accept-plan: chat approval is explicit — approve resolves the review, deny leaves it open (0041)",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "accept-plan";
      const { openPlanReview, planState } = await import("../db/plans");
      const { pendingInputs } = await import("../db/schema");
      for (const approved of [false, true]) {
        // The mock's call id is fixed; pending_inputs ids are global.
        db().delete(pendingInputs).where(eq(pendingInputs.id, "call_accept_1")).run();
        const id = conv(`accept-${approved}`);
        openPlanReview(db(), {
          id: `call_present_${approved}`,
          conversationId: id,
          card: { kind: "plan", version: 3, markdown: "# p\n- [ ] a\n", checklist: { done: 0, total: 1 } },
        });
        const run = await turn(id, "looks good, go");
        await waitFor(async () => {
          try {
            return (await getHookByToken("call_accept_1")) != null;
          } catch {
            return false;
          }
        }, "accept_plan approval hook");
        // Suspended on Chad's click; the review is still open.
        expect(listPendingInputs(db(), id).map((p) => p.id).sort()).toEqual(["call_accept_1", `call_present_${approved}`].sort());
        expect(planState(db(), id).kind).toBe("review");
        await chatApprovalHook.resume("call_accept_1", {
          kind: "approval",
          approved,
          ...(approved ? {} : { comment: "split the migration out" }),
        });
        resolvePendingInput(db(), "call_accept_1", { approved });
        expect((await run.returnValue).finishReason).toBe("stop");
        if (approved) {
          expect(planState(db(), id).kind).toBe("approved");
          expect(serialized(id)).toContain("Chad approved plan v3");
        } else {
          expect(planState(db(), id).kind).toBe("review");
          expect(serialized(id)).toContain("split the migration out");
        }
      }
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
    "background harness call: a step that THROWS settles the call failed and frees the slot (0038 bug: it stayed running forever)",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_HARNESS_MOCK = "throw";
      process.env.SWEATSHOP_CHAT_MOCK = "plain";
      try {
        const { projects } = await import("../db/schema");
        const { getHarnessCall } = await import("../db/harness-calls");
        const { getActiveHarnessRun } = await import("../lib/harness-events");
        const { startHarnessCall } = await import("../lib/chat/harness-call-start");
        db().insert(projects).values({ id: "p_xchat_hc", name: "HC", createdAt: 0 }).onConflictDoNothing().run();
        const id = `c_test_hcthrow_${Math.random().toString(36).slice(2, 8)}`;
        ensureConversation(db(), id, "p_xchat_hc");

        const started = await startHarnessCall({ conversationId: id, kind: "pi", task: "blow up" });
        expect(started.ok).toBe(true);
        if (!started.ok) return;

        await waitFor(async () => getHarnessCall(db(), started.callId)?.status !== "running", "call to settle", 20_000);
        const call = getHarnessCall(db(), started.callId)!;
        expect(call.status).toBe("failed");
        expect(call.error).toContain("mock harness step blew up");
        // The one-per-session slot is released: a second call is not "busy".
        expect(getActiveHarnessRun(id)).toBeNull();
        // ...and the chat is told, like any other failed call.
        await waitFor(
          async () => listMessageTexts(db(), id).some((r) => r.role === "user" && r.text.startsWith("[pi failed]")),
          "the failure wake",
        );
      } finally {
        delete process.env.SWEATSHOP_HARNESS_MOCK;
      }
    },
  );

  it(
    "background harness call: a FAILED turn still saves its resume handle, so the next call reattaches instead of spawning a second bridge (0038 bug: EADDRINUSE)",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_HARNESS_MOCK = "fail-resume";
      process.env.SWEATSHOP_CHAT_MOCK = "plain";
      try {
        const { projects } = await import("../db/schema");
        const { getHarnessCall } = await import("../db/harness-calls");
        const { getHarnessResumeState } = await import("../db/chat");
        const { startHarnessCall } = await import("../lib/chat/harness-call-start");
        db().insert(projects).values({ id: "p_xchat_hc", name: "HC", createdAt: 0 }).onConflictDoNothing().run();
        const id = `c_test_hcresume_${Math.random().toString(36).slice(2, 8)}`;
        ensureConversation(db(), id, "p_xchat_hc");

        const started = await startHarnessCall({ conversationId: id, kind: "pi", task: "fail but leave a bridge" });
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        await waitFor(async () => getHarnessCall(db(), started.callId)?.status !== "running", "call to settle");

        expect(getHarnessCall(db(), started.callId)?.status).toBe("failed");
        expect(getHarnessResumeState(db(), id, "pi")).toEqual({ mock: "resume-after-failure" });
        // The next call is handed that handle (the starter reads it from the store).
        const next = await startHarnessCall({ conversationId: id, kind: "pi", task: "again" });
        expect(next.ok).toBe(true);
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

  it(
    "orphaned pendings: a dead card never shadows a live one, cancel clears its cards, and a hookless Deny clears itself (2026-10-13 inbox bug)",
    { timeout: 60_000 },
    async () => {
      const { recordPendingInput, setActiveRun } = await import("../db/chat");
      const { pendingInputs } = await import("../db/schema");
      const { POST: inputPost } = await import("../app/api/x/input/route");
      const { POST: cancelPost } = await import("../app/api/x/chat/cancel/route");
      // Earlier tests leave RESOLVED rows for the mock's fixed tool-call
      // id (the row id is globally unique); free it — recordPendingInput
      // is conflict-do-nothing, so a leftover would silently hide ours.
      db().delete(pendingInputs).where(eq(pendingInputs.id, "call_ask_chad_1")).run();

      // 1) Typing answers the LIVE pending and resolves an older card
      // whose run already died (it would only ever resume "Hook not
      // found", so it must not swallow the text).
      process.env.SWEATSHOP_CHAT_MOCK = "approve";
      const idA = conv("orphanA");
      recordPendingInput(db(), {
        id: "call_orphan_dead",
        conversationId: idA,
        kind: "approval",
        question: "Open a PR (its run is already gone)",
      });
      const runA = await turn(idA, "please ask me");
      await waitFor(
        () => Promise.resolve(listPendingInputs(db(), idA).some((p) => p.id === "call_ask_chad_1")),
        "this turn's own ask_chad card",
      );
      const { answerPendingWithText } = await import("../lib/chat/answer-pending");
      expect(await answerPendingWithText(idA, "the dead one first")).toEqual({
        toolCallId: "call_ask_chad_1",
        kind: "approval",
      });
      const answer = JSON.parse(
        db().select().from(pendingInputs).where(eq(pendingInputs.id, "call_orphan_dead")).get()!
          .answer ?? "{}",
      ) as { orphaned?: string };
      expect(answer.orphaned).toBe("hook-gone");
      await runA.returnValue; // denied with the text — the turn finishes
      // The mock's fixed tool-call id is the row's primary key — free it
      // for the next flow (recordPendingInput is conflict-do-nothing).
      db().delete(pendingInputs).where(eq(pendingInputs.conversationId, idA)).run();

      // 2) The stop button's route clears the cancelled turn's cards;
      // a hookless plan review (0041) stays open.
      process.env.SWEATSHOP_CHAT_MOCK = "question";
      const idB = conv("orphanB");
      recordPendingInput(db(), {
        id: "plan_orphan_test",
        conversationId: idB,
        kind: "plan",
        question: "Plan v1 — plan rows are hookless",
      });
      const runB = await turn(idB, "please ask me a question");
      setActiveRun(db(), idB, runB.runId);
      await waitFor(
        () => Promise.resolve(listPendingInputs(db(), idB).some((p) => p.id === "call_ask_chad_1")),
        "this turn's own question card",
      );
      const cancelBody = await (
        await cancelPost(
          new Request("http://x", { method: "POST", body: JSON.stringify({ conversationId: idB }) }),
        )
      ).json();
      expect(cancelBody.cancelled).toBe(true);
      expect(cancelBody.clearedPending).toBe(1); // the question card, not the plan row
      expect(listPendingInputs(db(), idB).map((p) => p.id)).toEqual(["plan_orphan_test"]);
      await runB.returnValue.catch(() => undefined); // cancelled, never finishes
      db().delete(pendingInputs).where(eq(pendingInputs.conversationId, idB)).run();

      // 3) The reported bug itself: a card whose run was cancelled
      // (without the route — any cancel) answers 200 and clears.
      process.env.SWEATSHOP_CHAT_MOCK = "approve";
      const idC = conv("orphanC");
      const runC = await turn(idC, "please ask me");
      await waitFor(
        () => Promise.resolve(listPendingInputs(db(), idC).some((p) => p.id === "call_ask_chad_1")),
        "this turn's own ask_chad card",
      );
      await runC.cancel({ cancelReason: "test cancel" });
      const deny = await inputPost(
        new Request("http://x", {
          method: "POST",
          body: JSON.stringify({ toolCallId: "call_ask_chad_1", approved: false }),
        }),
      );
      expect(deny.status).toBe(200);
      expect(await deny.json()).toEqual({ resumed: false, cleared: true });
      expect(listPendingInputs(db(), idC)).toEqual([]);
    },
  );

  it(
    "skill: use_skill binds it, and the next turn runs with it in the instructions (0037/0039)",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "skill";
      const { getConversation } = await import("../db/chat");
      const id = conv("skill");
      await (await turn(id, "ship it")).returnValue;
      expect(getConversation(db(), id)?.skill).toBe("ship");
      expect(serialized(id)).toContain("Bound to this thread");
      expect(serialized(id)).toContain("mock-skill:false");

      await (await turn(id, "status?")).returnValue;
      expect(serialized(id)).toContain("mock-skill:true");
    },
  );

  it(
    "budget: a thread-skill turn that exhausts its steps continues in a wake turn (0037/0039)",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "loop";
      const { setConversationSkill, listMessageTexts: rows } = await import("../db/chat");
      const id = conv("budget");
      setConversationSkill(db(), id, "ship");
      const ret = await (await start(chatTurn, [{ conversationId: id, userText: "go", skillMaxSteps: 2 }])).returnValue;
      expect(ret.finishReason).toBe("tool-calls");
      // The continuation is a NEW turn (it records its own chip row; the
      // loop script would run it to 400 — the bound is unit-tested in
      // skills.test.ts).
      const budgetChips = () =>
        rows(db(), id).filter((r) => r.role === "user" && r.metadata?.runEvent?.kind === "budget");
      await waitFor(async () => budgetChips().length > 0, "the continuation turn's chip");
      const chips = budgetChips();
      expect(chips).toHaveLength(1);
      expect(chips[0]?.text).toContain("[budget]");
      const { getActiveRun } = await import("../db/chat");
      const next = getActiveRun(db(), id);
      expect(next).toBeTruthy();
      if (next) await getRun(next).cancel();
    },
  );
  it(
    "incremental persist: a multi-slice turn lands each slice as it finishes, without duplicates (run 5)",
    { timeout: 30_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "steer";
      const id = conv("incremental");
      const { enqueueSteer, getActiveRun } = await import("../db/chat");
      enqueueSteer(db(), id, "STEER_MARKER");
      const run = await turn(id, "go");
      // Before the turn ends, the first slice (the note tool call + its
      // result) is already in sqlite while the turn is still active.
      await waitFor(async () => {
        const roles = listModelMessages(db(), id).map((m) => m.role);
        return roles.includes("tool");
      }, "the first slice to persist");
      await run.returnValue;
      expect(getActiveRun(db(), id)).toBeNull();
      const rows = listMessageTexts(db(), id);
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      // (a steer queued before the turn is drained by the history load)
      expect(rows.map((r) => r.role)).toEqual(["user", "user", "assistant", "tool", "assistant"]);
      expect(rows.filter((r) => r.role === "assistant")[0]?.metadata?.route).toBeTruthy();
    },
  );
});
