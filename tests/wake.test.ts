import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import {
  appendMessages,
  ensureConversation,
  getActiveRun,
  getChatChild,
  listWakableChatChildren,
  peekSteer,
  setActiveRun,
  setConversationParent,
} from "../db/chat";
import { conversations } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  renderWake,
  sweepWakes,
  wakeChatChildIfDue,
  wakeConversation,
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

let seq = 0;
const chatId = () => `c_wk_${++seq}`;
const harnessDone: WakeEvent = {
  kind: "harness",
  id: "hc_x",
  name: "pi",
  status: "completed",
  detail: "done",
  url: "/h/pi/c_x",
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

describe("wakeConversation", () => {
  it("starts a turn when the parent is idle", async () => {
    const parent = chatId();
    ensureConversation(tdb, parent, null);
    const { deps, started } = seams();
    await expect(wakeConversation(parent, harnessDone, deps)).resolves.toBe("started");
    expect(started).toHaveLength(1);
    expect(started[0]!.conversationId).toBe(parent);
    expect(started[0]!.text).toContain("[pi finished]");
    expect(started[0]!.meta).toEqual({ kind: "harness", id: "hc_x", status: "completed" });
  });

  it("steers when the parent has a live turn", async () => {
    const parent = chatId();
    ensureConversation(tdb, parent, null);
    setActiveRun(tdb, parent, "wr_live");
    const { deps, started } = seams({ wr_live: "running" });
    await expect(wakeConversation(parent, harnessDone, deps)).resolves.toBe("steered");
    expect(peekSteer(tdb, parent)).toEqual([renderWake(harnessDone)]);
    expect(started).toHaveLength(0);
    expect(getActiveRun(tdb, parent)).toBe("wr_live");
  });

  it("sweeps a stale active row and starts", async () => {
    const parent = chatId();
    ensureConversation(tdb, parent, null);
    setActiveRun(tdb, parent, "wr_old");
    const { deps, started } = seams({ wr_old: "completed" });
    await expect(wakeConversation(parent, harnessDone, deps)).resolves.toBe("started");
    expect(started).toHaveLength(1);
    expect(getActiveRun(tdb, parent)).toBeNull();
  });

  it("reports gone for a missing or trashed parent", async () => {
    const { deps } = seams();
    await expect(wakeConversation("c_nope", harnessDone, deps)).resolves.toBe("gone");
    const trashed = chatId();
    ensureConversation(tdb, trashed, null);
    tdb.update(conversations).set({ trashedAt: 1 }).where(eq(conversations.id, trashed)).run();
    await expect(wakeConversation(trashed, harnessDone, deps)).resolves.toBe("gone");
  });
});

describe("sweepWakes", () => {
  it("delivers unwoken child settles and stamps them", async () => {
    const { child } = settledChild();
    const { deps } = seams();
    expect(await sweepWakes(deps)).toBeGreaterThanOrEqual(1);
    expect(listWakableChatChildren(tdb).map((c) => c.id)).not.toContain(child);
  });

  it("contains a failing wake without starving the rest", async () => {
    const bad = settledChild();
    const good = settledChild();
    const { deps } = seams({}, bad.parent);
    const before = listWakableChatChildren(tdb).map((c) => c.id);
    await expect(sweepWakes(deps)).resolves.toBeGreaterThanOrEqual(1); // good delivered
    expect(listWakableChatChildren(tdb).map((c) => c.id)).not.toContain(good.child);
    // bad stays due (its wake failed) — retried on the next pass, not lost.
    const after = listWakableChatChildren(tdb).map((c) => c.id);
    expect(before).toContain(bad.child);
    expect(after).toContain(bad.child);
  });
});

/** 0037 phase 3 — a child chat with a settled turn (messages landed,
 *  no live run). `setConversationParent` pre-stamps woken = updatedAt,
 *  so the fixture bumps updatedAt past it the way a real turn does. */
function settledChild(opts: { skill?: string; text?: string | null; parent?: string } = {}) {
  const parent = opts.parent ?? chatId();
  ensureConversation(tdb, parent, null);
  const child = `c_wkchild_${++seq}`;
  ensureConversation(tdb, child, null);
  setConversationParent(tdb, child, parent);
  if (opts.skill) tdb.update(conversations).set({ skill: opts.skill }).where(eq(conversations.id, child)).run();
  if (opts.text !== null) {
    appendMessages(tdb, child, [
      {
        id: `${child}_m1`,
        role: "assistant",
        text: opts.text ?? "Findings: 1) the dialog caps at 512px on 375px viewports.",
        modelMessage: { role: "assistant", content: opts.text ?? "findings" },
      },
    ]);
    // A real turn's messages land strictly after the creation stamp;
    // force that ordering (same-ms Date.now() would read "already
    // woken").
    tdb.update(conversations).set({ updatedAt: Date.now() + 1000 }).where(eq(conversations.id, child)).run();
  }
  return { child, parent };
}

describe("child threads (0037 phase 3)", () => {
  it("renders a thread settle with its skill and findings", () => {
    expect(
      renderWake({ kind: "thread", id: "c_1", name: "review", status: "completed", url: "/c/c_1" }),
    ).toBe("[review finished] — /c/c_1");
  });

  it("wakes the parent with the child's last message once per settle", async () => {
    const { child, parent } = settledChild({ skill: "review" });
    const { deps, started } = seams();
    await expect(wakeChatChildIfDue(getChatChild(tdb, child)!, deps)).resolves.toBe("woke");
    expect(started).toHaveLength(1);
    expect(started[0]!.conversationId).toBe(parent);
    expect(started[0]!.text).toContain("[review finished] — /c/" + child);
    expect(started[0]!.text).toContain("dialog caps at 512px");
    expect(started[0]!.meta).toEqual({ kind: "thread", id: child, status: "completed" });
    expect(getChatChild(tdb, child)!.wokenSettledAt).toBe(getChatChild(tdb, child)!.updatedAt);
    await expect(wakeChatChildIfDue(getChatChild(tdb, child)!, deps)).resolves.toBe("skipped");
    expect(listWakableChatChildren(tdb).map((c) => c.id)).not.toContain(child);
  });

  it("is not due while the child's turn is live (and a failed turn wakes as failed)", async () => {
    const { child } = settledChild();
    setActiveRun(tdb, child, "wr_live_child");
    const live = seams({ wr_live_child: "running" });
    await expect(wakeChatChildIfDue(getChatChild(tdb, child)!, live.deps)).resolves.toBe("none");
    const failed = seams({ wr_live_child: "failed" });
    await expect(wakeChatChildIfDue(getChatChild(tdb, child)!, failed.deps)).resolves.toBe("woke");
    expect(failed.started[0]!.meta).toEqual({ kind: "thread", id: child, status: "failed" });
    expect(getActiveRun(tdb, child)).toBeNull(); // stale row swept
  });

  it("stamps a never-started child woken instead of waking (nothing to report)", async () => {
    const { child } = settledChild({ text: null });
    const { deps, started } = seams();
    await expect(wakeChatChildIfDue(getChatChild(tdb, child)!, deps)).resolves.toBe("skipped");
    expect(started).toHaveLength(0);
    expect(listWakableChatChildren(tdb).map((c) => c.id)).not.toContain(child);
  });

  it("carries the child's findings at a wider clip than run wakes", async () => {
    const long = "FINDING ".repeat(700); // ~5.6k chars — a real review report
    const { child } = settledChild({ text: long });
    const { deps, started } = seams();
    await expect(wakeChatChildIfDue(getChatChild(tdb, child)!, deps)).resolves.toBe("woke");
    const text = started[0]!.text;
    expect(text).toContain("[clipped");
    expect(text.length).toBeLessThan(long.length);
    expect(text.length).toBeGreaterThan(2000); // the full findings, not a 500-char stub
  });

  it("skips a cancelled stale row without waking", async () => {
    const { child } = settledChild();
    setActiveRun(tdb, child, "wr_cancelled_child");
    const { deps, started } = seams({ wr_cancelled_child: "cancelled" });
    await expect(wakeChatChildIfDue(getChatChild(tdb, child)!, deps)).resolves.toBe("skipped");
    expect(started).toHaveLength(0);
    expect(getActiveRun(tdb, child)).toBeNull();
  });

  it("marks a gone (trashed) parent woken so the sweep does not retry", async () => {
    const { child, parent } = settledChild();
    tdb.update(conversations).set({ trashedAt: 1 }).where(eq(conversations.id, parent)).run();
    const { deps } = seams();
    await expect(wakeChatChildIfDue(getChatChild(tdb, child)!, deps)).resolves.toBe("skipped");
    expect(getChatChild(tdb, child)!.wokenSettledAt).toBe(getChatChild(tdb, child)!.updatedAt);
  });

  it("the sweep delivers child settles too", async () => {
    const { child } = settledChild();
    const { deps } = seams();
    // Not an exact count: earlier tests' fixtures may still be due.
    expect(await sweepWakes(deps)).toBeGreaterThanOrEqual(1);
    expect(listWakableChatChildren(tdb).map((c) => c.id)).not.toContain(child);
  });

  it("cancel_run stops a live child without waking its parent", async () => {
    const { child } = settledChild();
    setActiveRun(tdb, child, "wr_cancel_tool");
    const result = await cancelRunTool(child);
    expect(result).toMatchObject({ ok: true, runId: child, status: "cancelled" });
    expect(getActiveRun(tdb, child)).toBeNull();
    expect(listWakableChatChildren(tdb).map((c) => c.id)).not.toContain(child);
  });

  it("cancel_run value-shapes non-children and settled threads", async () => {
    const ownChat = chatId();
    ensureConversation(tdb, ownChat, null);
    setActiveRun(tdb, ownChat, "wr_own");
    expect(await cancelRunTool(ownChat)).toMatchObject({ ok: false, code: "not-a-child" });
    const { child } = settledChild();
    expect(await cancelRunTool(child)).toMatchObject({ ok: false, code: "not-live" });
    expect(await cancelRunTool("c_missing")).toMatchObject({ ok: false, code: "not-found" });
  });
});
