import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import {
  createMachine,
  createRun,
  getRun,
  listWakableRuns,
  updateRun,
} from "../db/machines";
import { ensureConversation, getActiveRun, peekSteer, setActiveRun } from "../db/chat";
import { conversations } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  renderWake,
  sweepWakes,
  wakeConversation,
  wakeRunIfDue,
  type WakeDeps,
  type WakeEvent,
} from "../lib/chat/wake";
import { cancelRunTool } from "../lib/agent/tools/cancel-run";

/**
 * 0022 cut 1 — the wake primitive, its routing (steer vs new turn), the
 * wake-once-per-settle idempotency, the sweep backstop, and cancel_run.
 * The turn starter and live-status check are injected seams: no workflow
 * runtime, no model.
 */

const tdb = openDb(process.env.SWEATSHOP_DB!);

createMachine(tdb, {
  id: "wk-think",
  name: "Think",
  definition: {
    workspace: "none",
    start: "think",
    stages: { think: { kind: "agent", title: "Think", instructions: "think", next: [{ to: "end" }] } },
  },
});

let seq = 0;
const chatId = () => `c_wk_${++seq}`;
/** A chat row + a settled run started from it (no workflow run id). */
function settledRun(opts: { status?: string; parent?: string | null } = {}) {
  const parent = opts.parent === undefined ? chatId() : opts.parent;
  if (parent) ensureConversation(tdb, parent, null);
  const run = createRun(tdb, {
    machineId: "wk-think",
    prompt: "wake test",
    ...(parent ? { parentConversationId: parent } : {}),
  });
  updateRun(tdb, run.id, { status: opts.status ?? "completed", currentStage: null });
  return { run: getRun(tdb, run.id), parent };
}

const finished: WakeEvent = {
  kind: "machine",
  id: "mr_x",
  name: "Ticket",
  status: "completed",
  detail: "PR #12 opened",
  url: "/r/mr_x",
};

/** Seams: record (id, text, meta) starts; activeRun statuses resolve per id. */
function seams(activeStatuses: Record<string, string> = {}, startThrowsFor: string | null = null) {
  const started: { conversationId: string; text: string; meta: unknown }[] = [];
  const deps: WakeDeps = {
    statusOf: (runId) => Promise.resolve(activeStatuses[runId] ?? "completed"),
    start: async (conversationId, text, meta) => {
      if (conversationId === startThrowsFor) throw new Error("boom");
      started.push({ conversationId, text, meta });
    },
  };
  return { deps, started };
}

describe("renderWake", () => {
  it("renders a short standalone machine event", () => {
    expect(renderWake(finished)).toBe(
      "[run finished] Ticket: completed — /r/mr_x\n\nPR #12 opened",
    );
  });

  it("renders a harness event without the run wording", () => {
    expect(
      renderWake({ kind: "harness", id: "hc_1", name: "pi", status: "completed", url: "/h/pi/c_1" }),
    ).toBe("[pi finished] — /h/pi/c_1");
  });
});

describe("wakeConversation", () => {
  it("starts a turn when the parent is idle", async () => {
    const parent = chatId();
    ensureConversation(tdb, parent, null);
    const { deps, started } = seams();
    await expect(wakeConversation(parent, finished, deps)).resolves.toBe("started");
    expect(started).toHaveLength(1);
    expect(started[0]!.conversationId).toBe(parent);
    expect(started[0]!.text).toContain("[run finished] Ticket");
    expect(started[0]!.meta).toEqual({ kind: "machine", id: "mr_x", status: "completed" });
  });

  it("steers when the parent has a live turn", async () => {
    const parent = chatId();
    ensureConversation(tdb, parent, null);
    setActiveRun(tdb, parent, "wr_live");
    const { deps, started } = seams({ wr_live: "running" });
    await expect(wakeConversation(parent, finished, deps)).resolves.toBe("steered");
    expect(peekSteer(tdb, parent)).toEqual([renderWake(finished)]);
    expect(started).toHaveLength(0);
    expect(getActiveRun(tdb, parent)).toBe("wr_live");
  });

  it("sweeps a stale active row and starts", async () => {
    const parent = chatId();
    ensureConversation(tdb, parent, null);
    setActiveRun(tdb, parent, "wr_old");
    const { deps, started } = seams({ wr_old: "completed" });
    await expect(wakeConversation(parent, finished, deps)).resolves.toBe("started");
    expect(started).toHaveLength(1);
    expect(getActiveRun(tdb, parent)).toBeNull();
  });

  it("reports gone for a missing or trashed parent", async () => {
    const { deps } = seams();
    await expect(wakeConversation("c_nope", finished, deps)).resolves.toBe("gone");
    const trashed = chatId();
    ensureConversation(tdb, trashed, null);
    tdb.update(conversations).set({ trashedAt: 1 }).where(eq(conversations.id, trashed)).run();
    await expect(wakeConversation(trashed, finished, deps)).resolves.toBe("gone");
  });
});

describe("wakeRunIfDue", () => {
  it("wakes once per settle, then skips", async () => {
    const { run, parent } = settledRun();
    const { deps, started } = seams();
    await expect(wakeRunIfDue(run, deps)).resolves.toBe("woke");
    expect(started).toHaveLength(1);
    expect(getRun(tdb, run.id).wokenSettledAt).toBe(run.settledAt);
    // The settle is delivered: not due again.
    expect(listWakableRuns(tdb).map((r) => r.id)).not.toContain(run.id);
    await expect(wakeRunIfDue(getRun(tdb, run.id), deps)).resolves.toBe("skipped");
    expect(parent).toBeTruthy();
  });

  it("wakes again on a NEW settle (e.g. waiting after a resume)", async () => {
    const { run } = settledRun();
    const { deps, started } = seams();
    await wakeRunIfDue(run, deps);
    updateRun(tdb, run.id, { status: "waiting", currentStage: "gate" });
    const again = getRun(tdb, run.id);
    await expect(wakeRunIfDue(again, deps)).resolves.toBe("woke");
    expect(started).toHaveLength(2);
    expect(started[1]!.text).toContain("waiting for your input");
  });

  it("ignores runs without a parent or without a settle", async () => {
    const orphans = settledRun({ parent: null });
    await expect(wakeRunIfDue(orphans.run, seams().deps)).resolves.toBe("none");
    const liveParent = chatId();
    ensureConversation(tdb, liveParent, null);
    const live = createRun(tdb, { machineId: "wk-think", prompt: "still going", parentConversationId: liveParent });
    await expect(wakeRunIfDue(getRun(tdb, live.id), seams().deps)).resolves.toBe("none");
  });

  it("marks a gone parent woken so the sweep does not retry forever", async () => {
    // The FK makes orphan parents impossible; "gone" means trashed.
    const { run, parent } = settledRun();
    tdb.update(conversations).set({ trashedAt: 1 }).where(eq(conversations.id, parent!)).run();
    const { deps } = seams();
    await expect(wakeRunIfDue(run, deps)).resolves.toBe("skipped");
    expect(getRun(tdb, run.id).wokenSettledAt).toBe(run.settledAt);
  });
});

describe("sweepWakes", () => {
  it("delivers unwoken settles and stamps them", async () => {
    const { run } = settledRun();
    const { deps } = seams();
    await expect(sweepWakes(deps)).resolves.toBe(1);
    expect(getRun(tdb, run.id).wokenSettledAt).toBe(run.settledAt);
    await expect(sweepWakes(deps)).resolves.toBe(0);
  });

  it("contains a failing wake without starving the rest", async () => {
    const bad = settledRun();
    const good = settledRun();
    const { deps } = seams({}, bad.parent);
    await expect(sweepWakes(deps)).resolves.toBe(1); // good delivered
    expect(listWakableRuns(tdb).map((r) => r.id)).not.toContain(good.run.id);
    // bad stays due (its wake failed) — retried on the next pass, not lost.
    expect(listWakableRuns(tdb).map((r) => r.id)).toContain(bad.run.id);
  });
});

describe("cancel_run", () => {
  it("cancels a live run and keeps its sandbox", async () => {
    const parent = chatId();
    ensureConversation(tdb, parent, null);
    const run = createRun(tdb, { machineId: "wk-think", prompt: "cancel me", parentConversationId: parent });
    const result = await cancelRunTool(run.id);
    expect(result).toMatchObject({ ok: true, runId: run.id, status: "cancelled" });
    expect(getRun(tdb, run.id).status).toBe("cancelled");
    // 0022 decision: cancelled runs never wake their parent.
    expect(listWakableRuns(tdb).map((r) => r.id)).not.toContain(run.id);
  });

  it("value-shapes not-found and not-live", async () => {
    expect(await cancelRunTool("mr_missing")).toMatchObject({ ok: false, code: "not-found" });
    const { run } = settledRun();
    expect(await cancelRunTool(run.id)).toMatchObject({ ok: false, code: "not-live" });
  });
});
