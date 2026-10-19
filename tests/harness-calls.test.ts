import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../db";
import {
  CALL_SETTLED_STATUSES,
  createHarnessCall,
  getHarnessCall,
  listHarnessCalls,
  listWakableCalls,
  settleHarnessCall,
  setCallWorkflowRun,
} from "../db/harness-calls";
import { ensureConversation } from "../db/chat";
import { claimHarnessRun, listActiveHarnessRuns, getHarnessEvents, getHarnessRun } from "../lib/harness-events";
import { conversations, harnessRuns, projects } from "../db/schema";
import { wakeCallIfDue, sweepWakes } from "../lib/chat/wake";
import { cancelRunTool } from "../lib/agent/tools/cancel-run";
import { startHarnessCall } from "../lib/chat/harness-call-start";

/**
 * 0022 cut 2 — background harness calls: the store's settle-once
 * semantics, the starter's value-shaped results (with an injected
 * workflow starter — no harness, no podman), the wake, and cancel.
 */

const tdb = openDb(process.env.SWEATSHOP_DB!);

// A project conversation (pi/claude require one); fresh per test so the
// one-per-session slot never leaks between them.
tdb.insert(projects).values({ id: "p_hc", name: "HC", createdAt: 0 }).onConflictDoNothing().run();
let n = 0;
const newConv = () => {
  const id = `c_hc_${++n}`;
  ensureConversation(tdb, id, "p_hc");
  return id;
};

/** A running call row on a fresh conversation. */
function runningCall(kind: "pi" | "claude" = "pi") {
  const conversationId = newConv();
  return {
    conversationId,
    call: createHarnessCall(tdb, { conversationId, kind, task: `task ${++n}` }),
  };
}

describe("harness_calls store", () => {
  it("settles exactly once — a racing second settle is dropped", () => {
    const { call } = runningCall();
    expect(settleHarnessCall(tdb, call.id, { status: "completed", result: "done" })).toBe(true);
    expect(settleHarnessCall(tdb, call.id, { status: "cancelled" })).toBe(false);
    const row = getHarnessCall(tdb, call.id)!;
    expect(row.status).toBe("completed");
    expect(row.result).toBe("done");
    expect(row.settledAt).toBeTruthy();
  });

  it("cancelled never settles (no wake) and completed/failed are wakable", () => {
    const { call: done } = runningCall();
    settleHarnessCall(tdb, done.id, { status: "completed", result: "ok" });
    const { call: lost } = runningCall();
    settleHarnessCall(tdb, lost.id, { status: "failed", error: "boom" });
    const { call: cancelled } = runningCall();
    settleHarnessCall(tdb, cancelled.id, { status: "cancelled" });
    const wakable = listWakableCalls(tdb).map((c) => c.id);
    expect(wakable).toContain(done.id);
    expect(wakable).toContain(lost.id);
    expect(wakable).not.toContain(cancelled.id);
    expect(CALL_SETTLED_STATUSES.has("cancelled")).toBe(false);
  });
});

describe("wakeCallIfDue", () => {
  it("wakes with the result (completed) or error (failed), once each", async () => {
    const { call: done } = runningCall();
    settleHarnessCall(tdb, done.id, { status: "completed", result: "the fix is in" });
    const started: string[] = [];
    const deps = {
      statusOf: () => Promise.resolve("completed"),
      start: async (id: string, text: string) => {
        started.push(text);
        void id;
      },
    };
    const call = getHarnessCall(tdb, done.id)!;
    await expect(wakeCallIfDue(call, deps)).resolves.toBe("woke");
    expect(started[0]).toContain("[pi finished]");
    expect(started[0]).toContain("the fix is in");
    expect(getHarnessCall(tdb, done.id)!.wokenSettledAt).toBe(call.settledAt);
    // Delivered — not due again, and the sweep agrees.
    await expect(wakeCallIfDue(getHarnessCall(tdb, done.id)!, deps)).resolves.toBe("skipped");
    expect(listWakableCalls(tdb).map((c) => c.id)).not.toContain(done.id);
  });
});

describe("startHarnessCall", () => {
  const fakeStart = async (input: { callId: string }) => {
    setCallWorkflowRun(tdb, input.callId, "wr_fake");
    return { runId: "wr_fake" };
  };

  it("returns a handle without advancing, and records the call + slot", async () => {
    const conv = newConv();
    const result = await startHarnessCall({ conversationId: conv, kind: "pi", task: "fix it", start: fakeStart });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const call = getHarnessCall(tdb, result.callId)!;
    expect(call.status).toBe("running");
    expect(call.workflowRunId).toBe("wr_fake");
    expect(listActiveHarnessRuns(conv).map((r) => r.kind)).toEqual(["pi"]);
    // No events-page transcript rows were fabricated; the start event is real.
    expect(getHarnessRun(conv, "pi")?.status).toBe("running");
    // The session page shows what pi was asked: the task rides on start.
    const start = getHarnessEvents(conv, "pi").events.find((e) => e.kind === "start");
    expect(start?.input).toBe("fix it");
  });

  it("appends the result instruction to the WORKFLOW prompt only — the stored task and start event keep the raw ask (0040 phase 3)", async () => {
    const conv = newConv();
    const seen: { task: string }[] = [];
    const captureStart = async (input: { callId: string; task: string }) => {
      seen.push({ task: input.task });
      setCallWorkflowRun(tdb, input.callId, "wr_fake");
      return { runId: "wr_fake" };
    };
    const result = await startHarnessCall({ conversationId: conv, kind: "pi", task: "fix it", start: captureStart });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;

    // What actually ran gets the appended instruction...
    expect(seen).toHaveLength(1);
    expect(seen[0]!.task).toContain("fix it");
    expect(seen[0]!.task).toContain("End with a final message that is your result");
    expect(seen[0]!.task).not.toBe("fix it");

    // ...but the durable record of what was ASKED stays exactly what the
    // model/tool caller wrote — inspect and the events page must never
    // show the instruction as if Chad or the agent asked for it.
    const call = getHarnessCall(tdb, result.callId)!;
    expect(call.task).toBe("fix it");
    const start = getHarnessEvents(conv, "pi").events.find((e) => e.kind === "start");
    expect(start?.input).toBe("fix it");
  });

  it("0038 amendment: a different kind runs alongside an active one — only the SAME kind is busy", async () => {
    const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token"; // past startHarnessCall's not-configured gate
    try {
      const conv = newConv();
      expect(claimHarnessRun(conv, "claude")).toMatchObject({ ok: true });
      // pi is a different kind — it may start even while claude is running.
      const ok = await startHarnessCall({ conversationId: conv, kind: "pi", task: "concurrent", start: fakeStart });
      expect(ok).toMatchObject({ ok: true });
      // claude again, while its own call is still running, is busy.
      const busy = await startHarnessCall({ conversationId: conv, kind: "claude", task: "again", start: fakeStart });
      expect(busy).toMatchObject({ ok: false, code: "busy" });
      if (!busy.ok) expect(busy.message).toContain("already running");
    } finally {
      if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
    }
  });

  // The cap itself (claimHarnessRun returning reason:"cap") is covered
  // directly in tests/harness-events.test.ts — 0050 grew the roster to
  // four kinds against MAX_CONCURRENT_HARNESSES 3, so the cap is live
  // reachable, not just headroom.

  it("0038: cursor refuses value-shaped (and never claims the slot) until a login exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-auth-"));
    const prev = process.env.HARNESS_AUTH_DIR;
    process.env.HARNESS_AUTH_DIR = dir;
    try {
      const conv = newConv();
      const result = await startHarnessCall({ conversationId: conv, kind: "cursor", task: "x", start: fakeStart });
      expect(result).toMatchObject({ ok: false, code: "not-configured" });
      if (!result.ok) expect(result.message).toContain("agent login");
      expect(listActiveHarnessRuns(conv)).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.HARNESS_AUTH_DIR;
      else process.env.HARNESS_AUTH_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("0050: codex refuses value-shaped until a ChatGPT login exists, then starts on the builtin default", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"));
    const prev = process.env.HARNESS_AUTH_DIR;
    process.env.HARNESS_AUTH_DIR = dir;
    const fakeCodexAuthJson = (expMs: number) => {
      const jwt = (exp: number) =>
        ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString("base64url"), "sig"].join(".");
      return JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt(expMs), refresh_token: "r" } });
    };
    try {
      // No file yet: the gate answers before a slot is claimed.
      const conv = newConv();
      const refused = await startHarnessCall({ conversationId: conv, kind: "codex", task: "x", start: fakeStart });
      expect(refused).toMatchObject({ ok: false, code: "not-configured" });
      if (!refused.ok) expect(refused.message).toContain("Log in with ChatGPT");
      expect(listActiveHarnessRuns(conv)).toHaveLength(0);

      // With a login the builtin default route ({harness:"codex",
      // model:"gpt-5.6-sol"} — always pinned, 0050 review) resolves
      // and validates, and the call starts exactly like any other kind.
      const { saveCodexCredential } = await import("../lib/harness-auth/codex");
      saveCodexCredential(fakeCodexAuthJson(Date.now() + 30 * 86_400_000));
      const started = await startHarnessCall({ conversationId: conv, kind: "codex", task: "x", start: fakeStart });
      expect(started).toMatchObject({ ok: true });
      expect(listActiveHarnessRuns(conv).map((r) => r.kind)).toEqual(["codex"]);
    } finally {
      if (prev === undefined) delete process.env.HARNESS_AUTH_DIR;
      else process.env.HARNESS_AUTH_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses without a project", async () => {
    const bare = newConv();
    tdb.update(conversations).set({ projectId: null }).where(eq(conversations.id, bare)).run();
    const result = await startHarnessCall({ conversationId: bare, kind: "pi", task: "x", start: fakeStart });
    expect(result).toMatchObject({ ok: false, code: "no-project" });
  });

  it("cleans up (slot + failed row) when the workflow cannot start", async () => {
    const conv = newConv();
    const failing = async () => {
      throw new Error("no executor");
    };
    const result = await startHarnessCall({ conversationId: conv, kind: "pi", task: "x", start: failing });
    expect(result).toMatchObject({ ok: false, code: "start-failed" });
    expect(listActiveHarnessRuns(conv)).toHaveLength(0);
    // The call row stays as a visible failure (its wake fires via the sweep).
    const calls = listHarnessCalls(tdb, { conversationId: conv });
    expect(calls[0]).toMatchObject({ status: "failed" });
    expect(listWakableCalls(tdb).map((c) => c.id)).toContain(calls[0]!.id);
  });
});

describe("cancel_run on hc_", () => {
  it("cancels a running call and releases the slot", async () => {
    const { conversationId: conv, call } = runningCall();
    expect(claimHarnessRun(conv, "pi")).toMatchObject({ ok: true });
    const result = await cancelRunTool(call.id);
    expect(result).toMatchObject({ ok: true, runId: call.id, status: "cancelled" });
    expect(getHarnessCall(tdb, call.id)!.status).toBe("cancelled");
    expect(getHarnessRun(conv, "pi")?.status).toBe("cancelled");
    expect(listActiveHarnessRuns(conv)).toHaveLength(0);
    // A cancelled call never wakes.
    expect(listWakableCalls(tdb).map((c) => c.id)).not.toContain(call.id);
  });

  it("value-shapes not-found and not-live", async () => {
    expect(await cancelRunTool("hc_missing")).toMatchObject({ ok: false, code: "not-found" });
    const { call: done } = runningCall();
    settleHarnessCall(tdb, done.id, { status: "completed", result: "x" });
    expect(await cancelRunTool(done.id)).toMatchObject({ ok: false, code: "not-live" });
  });
});

describe("sweepWakes with calls", () => {
  it("sweeps unwoken harness settles too", async () => {
    const { call } = runningCall();
    settleHarnessCall(tdb, call.id, { status: "completed", result: "swept" });
    // No live turn on the conversation: the sweep starts one via the seam.
    const started: string[] = [];
    const deps = {
      statusOf: () => Promise.resolve("completed"),
      start: async (_id: string, text: string) => {
        started.push(text);
      },
    };
    await expect(sweepWakes(deps)).resolves.toBeGreaterThanOrEqual(1);
    expect(started.some((t) => t.includes("swept"))).toBe(true);
    expect(listWakableCalls(tdb).map((c) => c.id)).not.toContain(call.id);
  });

  it("does not wake a trashed conversation (marked, not retried)", async () => {
    const trashedConv = "c_hc_trashed";
    ensureConversation(tdb, trashedConv, "p_hc");
    tdb.update(conversations).set({ trashedAt: 1 }).where(eq(conversations.id, trashedConv)).run();
    const call = createHarnessCall(tdb, { conversationId: trashedConv, kind: "pi", task: "t" });
    settleHarnessCall(tdb, call.id, { status: "completed", result: "r" });
    const deps = {
      statusOf: () => Promise.resolve("completed"),
      start: async () => {
        throw new Error("must not start");
      },
    };
    await expect(wakeCallIfDue(getHarnessCall(tdb, call.id)!, deps)).resolves.toBe("skipped");
    expect(getHarnessCall(tdb, call.id)!.wokenSettledAt).toBe(getHarnessCall(tdb, call.id)!.settledAt);
    // harness_runs slot bookkeeping is untouched by trashed parents
    expect(tdb.select().from(harnessRuns).where(eq(harnessRuns.sessionId, trashedConv)).all()).toHaveLength(0);
  });
});
