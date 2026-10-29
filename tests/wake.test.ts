import { describe, expect, it } from "vitest";
import type { Experimental_SandboxSession } from "ai";
import { db, openDb } from "../db";
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
import { conversations, projects } from "../db/schema";
import { createHarnessCall, getHarnessCall, settleHarnessCall } from "../db/harness-calls";
import { eq } from "drizzle-orm";
import {
  renderWake,
  sweepWakes,
  wakeCallIfDue,
  wakeChatChildIfDue,
  wakeConversation,
  type WakeDeps,
  type WakeEvent,
} from "../lib/chat/wake";
import { cancelRunTool } from "../lib/agent/tools/cancel-run";
import { runBash } from "../lib/agent/tools/bash";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";

/** Minimal fake sandbox — binds on first bash use, "writes" result files
 *  by just accepting the write command (same shape as tests/result-file.test.ts). */
class FakeSandboxProvider implements SandboxProvider {
  readonly kind = "fake";
  private n = 0;
  create(): Promise<SandboxHandle> {
    this.n += 1;
    return Promise.resolve(this.handle(`fake-${this.n}`));
  }
  attach(ref: string): SandboxHandle {
    return this.handle(ref);
  }
  async stop() {}
  async resume() {}
  async destroy() {}
  private handle(ref: string): SandboxHandle {
    return {
      ref,
      run: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      spawn: (() => {
        throw new Error("spawn not needed here");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
}

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

describe("wakeCallIfDue: two harness calls settling close together (0038 amendment)", () => {
  it("delivers both — one starts the turn, the other steers behind it", async () => {
    const parent = chatId();
    ensureConversation(tdb, parent, null);
    const piCreated = createHarnessCall(tdb, { conversationId: parent, kind: "pi", task: "a" });
    const claudeCreated = createHarnessCall(tdb, { conversationId: parent, kind: "claude", task: "b" });
    settleHarnessCall(tdb, piCreated.id, { status: "completed", result: "pi's fix" });
    settleHarnessCall(tdb, claudeCreated.id, { status: "completed", result: "claude's fix" });
    // Re-read: createHarnessCall's return is the pre-settle (running) row.
    const pi = getHarnessCall(tdb, piCreated.id)!;
    const claude = getHarnessCall(tdb, claudeCreated.id)!;

    // A faithful-enough double: unlike the generic seams() helper, `start`
    // here actually claims the active-run row, the way startChatTurn does
    // — so the second wake processed behind the first's lock sees a live
    // turn and steers, instead of a second "started" overwriting the first.
    const started: { conversationId: string; text: string }[] = [];
    const deps: WakeDeps = {
      statusOf: (runId) => Promise.resolve(runId === "wr_live" ? "running" : "completed"),
      start: async (conversationId, text) => {
        started.push({ conversationId, text });
        setActiveRun(tdb, conversationId, "wr_live");
      },
    };

    const [a, b] = await Promise.all([wakeCallIfDue(pi, deps), wakeCallIfDue(claude, deps)]);
    const piRow = getHarnessCall(tdb, pi.id)!;
    const claudeRow = getHarnessCall(tdb, claude.id)!;

    expect([a, b]).toEqual(["woke", "woke"]);
    // Both delivered: one landed as the turn start, the other as steer —
    // never both as a start (that would silently clobber one), never
    // neither (that would lose one).
    const steered = peekSteer(tdb, parent);
    const allText = [...started.map((s) => s.text), ...steered].join("\n---\n");
    expect(allText).toContain("[pi finished]");
    expect(allText).toContain("pi's fix");
    expect(allText).toContain("[claude finished]");
    expect(allText).toContain("claude's fix");
    expect(started).toHaveLength(1);
    expect(steered).toHaveLength(1);
    // Each call's own wake bookkeeping is independent — both stamped.
    expect(piRow.wokenSettledAt).toBe(piRow.settledAt);
    expect(claudeRow.wokenSettledAt).toBe(claudeRow.settledAt);
  });
});

describe("wakeCallIfDue: wide cap and the result-file pointer (0040 phase 3)", () => {
  it("carries a long result in full under the 16k cap", async () => {
    const parent = chatId();
    ensureConversation(tdb, parent, null);
    const long = "FINDING ".repeat(700).trim();
    const call = createHarnessCall(tdb, { conversationId: parent, kind: "pi", task: "a" });
    settleHarnessCall(tdb, call.id, { status: "completed", result: long });
    const { deps, started } = seams();
    await expect(wakeCallIfDue(getHarnessCall(tdb, call.id)!, deps)).resolves.toBe("woke");
    expect(started[0]!.text).toContain(long);
    expect(started[0]!.text).not.toContain("more chars");
  });

  it("points at the already-written result file — reads harness_calls.result_file back verbatim, never re-derives or re-writes", async () => {
    const parent = chatId();
    ensureConversation(tdb, parent, null);
    const long = "FINDING ".repeat(5_000).trim();
    const call = createHarnessCall(tdb, { conversationId: parent, kind: "pi", task: "a" });
    const resultFile = `/work/${parent}/.sweatshop/results/${call.id}.md`;
    // Simulates what harnessSettleStep already did at settle time — the
    // sweep path must never call saveResultFile itself.
    settleHarnessCall(tdb, call.id, { status: "completed", result: long, resultFile });
    const { deps, started } = seams();
    await expect(wakeCallIfDue(getHarnessCall(tdb, call.id)!, deps)).resolves.toBe("woke");
    const text = started[0]!.text;
    expect(text.length).toBeLessThan(long.length);
    expect(text).toContain("more chars");
    expect(text).toContain(`full result (${long.length} chars): ${resultFile}`);
  });

  it("no recorded file: points at inspect in the clip, and says so with no reason (the sweep never learned why)", async () => {
    const parent = chatId();
    ensureConversation(tdb, parent, null);
    const long = "FINDING ".repeat(5_000).trim();
    const call = createHarnessCall(tdb, { conversationId: parent, kind: "pi", task: "a" });
    settleHarnessCall(tdb, call.id, { status: "completed", result: long }); // resultFile stays null
    const { deps, started } = seams();
    await expect(wakeCallIfDue(getHarnessCall(tdb, call.id)!, deps)).resolves.toBe("woke");
    const text = started[0]!.text;
    expect(text).toContain("more chars");
    expect(text).toContain(`no file saved; inspect ${call.id}`);
    expect(text).toContain("no result file saved");
    expect(text).not.toContain("no result file saved (");
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
function settledChild(opts: { text?: string | null; parent?: string } = {}) {
  const parent = opts.parent ?? chatId();
  ensureConversation(tdb, parent, null);
  const child = `c_wkchild_${++seq}`;
  ensureConversation(tdb, child, null);
  setConversationParent(tdb, child, parent);
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
  it("renders a thread settle", () => {
    expect(
      renderWake({ kind: "thread", id: "c_1", name: "review", status: "completed", url: "/c/c_1" }),
    ).toBe("[review finished] — /c/c_1");
  });

  it("wakes the parent with the child's last message once per settle", async () => {
    const { child, parent } = settledChild();
    const { deps, started } = seams();
    await expect(wakeChatChildIfDue(getChatChild(tdb, child)!, deps)).resolves.toBe("woke");
    expect(started).toHaveLength(1);
    expect(started[0]!.conversationId).toBe(parent);
    expect(started[0]!.text).toContain("[thread finished] — /c/" + child);
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

  it("carries the child's findings in full when under the wide 16k cap", async () => {
    // lastAssistantReport trims the stored text, so the report the wake
    // sees drops the fixture string's trailing space.
    const long = "FINDING ".repeat(700).trim(); // ~5.6k chars — a real review report
    const { child } = settledChild({ text: long });
    const { deps, started } = seams();
    await expect(wakeChatChildIfDue(getChatChild(tdb, child)!, deps)).resolves.toBe("woke");
    const text = started[0]!.text;
    expect(text).toContain(long);
    expect(text).not.toContain("more chars");
  });

  it("clips past WAKE_DETAIL_CAP and points at the saved result file", async () => {
    const long = "FINDING ".repeat(5_000).trim(); // ~40k chars — over the 16k cap
    const { child, parent } = settledChild({ text: long });
    db().insert(projects).values({ id: "p_wk_clip", name: "WkClip", createdAt: 0 }).onConflictDoNothing().run();
    db().update(conversations).set({ projectId: "p_wk_clip" }).where(eq(conversations.id, parent)).run();
    const provider = new FakeSandboxProvider();
    await runBash(parent, "pwd", provider); // bind the parent's sandbox
    const { deps, started } = seams();
    deps.resultFileProvider = provider;
    await expect(wakeChatChildIfDue(getChatChild(tdb, child)!, deps)).resolves.toBe("woke");
    const text = started[0]!.text;
    expect(text.length).toBeLessThan(long.length);
    expect(text).toContain("more chars");
    expect(text).toContain(`full result (${long.length} chars): /work/${parent}/.sweatshop/results/`);
    expect(text).toContain("read or grep it with bash");
  });

  it("clips past WAKE_DETAIL_CAP and points at inspect when there is no bound sandbox to save into", async () => {
    const long = "FINDING ".repeat(5_000).trim();
    const { child } = settledChild({ text: long });
    const { deps, started } = seams();
    await expect(wakeChatChildIfDue(getChatChild(tdb, child)!, deps)).resolves.toBe("woke");
    const text = started[0]!.text;
    expect(text).toContain("more chars");
    expect(text).toContain(`no file saved; inspect ${child}`);
    expect(text).toContain("no result file saved (no bound sandbox)");
  });

  it("reports an exhausted child's wake as \"ran out of steps\"", async () => {
    const { child } = settledChild({ text: null });
    appendMessages(tdb, child, [
      {
        id: `${child}_earlier`,
        role: "assistant",
        text: "partial findings before the budget ran out",
        modelMessage: { role: "assistant", content: "x" },
      },
      {
        id: `${child}_exhausted`,
        role: "assistant",
        text: "[tool bash]",
        modelMessage: { role: "assistant", content: "x" },
        metadata: { exhausted: true },
      },
    ]);
    tdb.update(conversations).set({ updatedAt: Date.now() + 2000 }).where(eq(conversations.id, child)).run();
    const { deps, started } = seams();
    await expect(wakeChatChildIfDue(getChatChild(tdb, child)!, deps)).resolves.toBe("woke");
    expect(started[0]!.text).toContain("[thread ran out of steps]");
    expect(started[0]!.meta).toEqual({ kind: "thread", id: child, status: "ran out of steps" });
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
