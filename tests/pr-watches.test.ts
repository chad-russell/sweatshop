import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { ensureConversation, getActiveRun, peekSteer, setActiveRun } from "../db/chat";
import { conversations } from "../db/schema";
import {
  getPrWatch,
  listOpenPrWatches,
  prWatchId,
  settlePrWatch,
  upsertPrWatch,
} from "../db/pr-watches";
import {
  PR_WATCH_CAP,
  prWakeEvent,
  prWatchEnabled,
  sweepPRWatches,
  type PRWatchDeps,
} from "../lib/prs/sweep";
import type { PRWatch } from "../db/schema";
import { renderWake } from "../lib/chat/wake";

/**
 * 0084 — pr_watches: the store (deterministic ids, idempotent
 * registration, settle-once), then (below, added with the sweep) the
 * watch pass: open→merged/closed settles and wakes the opening chat
 * exactly once. The host fetch is always a seam — tests never hit a
 * real host.
 */

const tdb = db();

let seq = 0;
const chatId = () => `c_prw_${++seq}`;

function watchFixture(opts: { baseUrl?: string; owner?: string; repo?: string; number?: number } = {}) {
  const conversationId = chatId();
  ensureConversation(tdb, conversationId, null);
  return {
    conversationId,
    baseUrl: opts.baseUrl ?? "https://github.com",
    owner: opts.owner ?? "chad-russell",
    repo: opts.repo ?? "sweatshop",
    number: opts.number ?? 40 + (seq % 50),
  };
}

describe("prWatchId", () => {
  it("is deterministic and coordinate-qualified", () => {
    expect(prWatchId("https://github.com", "o", "r", 7)).toBe(
      prWatchId("https://github.com", "o", "r", 7),
    );
    // Same owner/repo/number on a different instance is a different PR.
    expect(prWatchId("https://git.crussell.io", "o", "r", 7)).not.toBe(
      prWatchId("https://github.com", "o", "r", 7),
    );
    expect(prWatchId("https://github.com", "o", "r", 8)).not.toBe(
      prWatchId("https://github.com", "o", "r", 7),
    );
    expect(prWatchId("https://github.com", "o", "r", 7)).toMatch(/^prw_[0-9a-f]{12}$/);
  });
});

describe("upsertPrWatch", () => {
  it("registers an open watch; re-watching the same PR is a no-op (one row)", () => {
    const input = watchFixture();
    const first = upsertPrWatch(tdb, input, 1_000);
    expect(first).toMatchObject({ ...input, state: "open", settledAt: null });
    const second = upsertPrWatch(tdb, input, 2_000);
    expect(second).toMatchObject(first);
    expect(listOpenPrWatches(tdb, 100).filter((w) => w.id === first.id)).toHaveLength(1);
  });

  it("never clobbers a settled watch back to open", () => {
    const input = watchFixture();
    const row = upsertPrWatch(tdb, input, 1_000);
    expect(settlePrWatch(tdb, row.id, "merged", 5_000)).toBe(true);
    // A somehow re-registered settled PR stays settled — the wake fired,
    // and hosts never reopen a merged PR number anyway.
    upsertPrWatch(tdb, { ...input, conversationId: chatId() }, 9_000);
    const after = getPrWatch(tdb, row.id)!;
    expect(after.state).toBe("merged");
    expect(after.settledAt).toBe(5_000);
    expect(listOpenPrWatches(tdb, 100)).not.toContainEqual(after);
  });
});

describe("settlePrWatch", () => {
  it("settles exactly once — the second settler loses", () => {
    const input = watchFixture();
    const row = upsertPrWatch(tdb, input);
    expect(settlePrWatch(tdb, row.id, "closed")).toBe(true);
    expect(settlePrWatch(tdb, row.id, "closed")).toBe(false);
    expect(settlePrWatch(tdb, row.id, "merged")).toBe(false); // terminal, never moves
    expect(getPrWatch(tdb, row.id)).toMatchObject({ state: "closed" });
  });

  it("lists open watches longest-waiting first, up to the cap", () => {
    const base = watchFixture();
    const ids: string[] = [];
    // openedAt below every other fixture's so the cap list is exactly
    // these rows, oldest first.
    for (let i = 0; i < 12; i += 1) {
      const row = upsertPrWatch(tdb, { ...base, number: 600 + i }, 1 + i);
      ids.push(row.id);
    }
    const listed = listOpenPrWatches(tdb, 10).map((w) => w.id);
    expect(listed).toEqual(ids.slice(0, 10)); // oldest first, capped
    for (const id of ids) settlePrWatch(tdb, id, "closed"); // leave the worklist clean
  });

  it("cascades away with its conversation", () => {
    const input = watchFixture();
    const row = upsertPrWatch(tdb, input);
    tdb.delete(conversations).where(eq(conversations.id, input.conversationId)).run();
    expect(getPrWatch(tdb, row.id)).toBeNull();
  });
});

/** Sweeps never touch a host: stateOf is a seam recording what the
 *  "host" would say; wake delivery is recorded like wake.test.ts's
 *  seams() (statusOf keeps any active run live). */
function sweepSeams(states: Record<string, { state: "open" | "merged" | "closed" } | null>) {
  const asked: string[] = [];
  const started: { conversationId: string; text: string; meta: unknown }[] = [];
  const deps: PRWatchDeps = {
    prWatch: "on",
    stateOf: async (watch) => {
      asked.push(watch.id);
      return states[watch.id] ?? null;
    },
    statusOf: (runId) => Promise.resolve(runId === "wr_pr_live" ? "running" : "completed"),
    start: async (conversationId, text, meta) => {
      started.push({ conversationId, text, meta });
    },
  };
  return { deps, asked, started };
}

describe("sweepPRWatches (0084)", () => {
  it("renders the PR wake — header, url, and the #N state (owner/repo) cite", () => {
    const input = watchFixture({ number: 47 });
    const watch = upsertPrWatch(tdb, input, 0);
    expect(renderWake(prWakeEvent(watch, { state: "merged" }))).toBe(
      `[pr merged] — ${input.baseUrl}/${input.owner}/${input.repo}/pull/47\n\n#47 merged (${input.owner}/${input.repo})`,
    );
    settlePrWatch(tdb, watch.id, "closed"); // leave the worklist clean
  });

  it("renders a forgejo wake with /pulls/<n> (github stays /pull/<n>)", () => {
    const forgejo = upsertPrWatch(tdb, watchFixture({ baseUrl: "https://git.crussell.io", number: 7 }), 0);
    expect(renderWake(prWakeEvent(forgejo, { state: "closed" }))).toContain(
      "git.crussell.io/chad-russell/sweatshop/pulls/7",
    );
    settlePrWatch(tdb, forgejo.id, "closed"); // leave the worklist clean
  });

  it("open→merged settles and wakes exactly once, even under a double sweep", async () => {
    const input = watchFixture({ number: 61 });
    const watch = upsertPrWatch(tdb, input, 0);
    const seams = sweepSeams({ [watch.id]: { state: "merged" } });
    // Two passes racing on the same open watch: both list it, both ask
    // the host, but the conditional settle admits exactly one waker.
    const results = await Promise.all([sweepPRWatches(seams.deps), sweepPRWatches(seams.deps)]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(seams.started).toHaveLength(1);
    expect(seams.started[0]!.conversationId).toBe(input.conversationId);
    expect(seams.started[0]!.text).toContain(`#61 merged (${input.owner}/${input.repo})`);
    expect(seams.started[0]!.text).toContain(`${input.baseUrl}/${input.owner}/${input.repo}/pull/61`);
    expect(seams.started[0]!.meta).toEqual({ kind: "pr", id: watch.id, status: "merged" });
    expect(getPrWatch(tdb, watch.id)).toMatchObject({ state: "merged", settledAt: expect.any(Number) });
    // And a later pass over the settled row is silent.
    expect(await sweepPRWatches(seams.deps)).toBe(0);
    expect(seams.started).toHaveLength(1);
  });

  it("open→closed wakes with the closed cite", async () => {
    const input = watchFixture({ number: 62 });
    const watch = upsertPrWatch(tdb, input, 0);
    const seams = sweepSeams({ [watch.id]: { state: "closed" } });
    expect(await sweepPRWatches(seams.deps)).toBe(1);
    expect(seams.started[0]!.text).toContain(`#62 closed (${input.owner}/${input.repo})`);
    expect(seams.started[0]!.meta).toEqual({ kind: "pr", id: watch.id, status: "closed" });
    expect(getPrWatch(tdb, watch.id)!.state).toBe("closed");
  });

  it("a live turn queues the PR wake as steer, like any child settle", async () => {
    const input = watchFixture({ number: 63 });
    const watch = upsertPrWatch(tdb, input, 0);
    setActiveRun(tdb, input.conversationId, "wr_pr_live");
    const seams = sweepSeams({ [watch.id]: { state: "merged" } });
    expect(await sweepPRWatches(seams.deps)).toBe(1);
    expect(seams.started).toHaveLength(0);
    expect(peekSteer(tdb, input.conversationId).join("\n")).toContain(`#63 merged (${input.owner}/${input.repo})`);
    expect(getActiveRun(tdb, input.conversationId)).toBe("wr_pr_live");
    expect(getPrWatch(tdb, watch.id)!.state).toBe("merged");
  });

  it("host unknown (null) or still-open never settles", async () => {
    const unknown = watchFixture({ number: 64 });
    const stillOpen = watchFixture({ number: 65 });
    const w1 = upsertPrWatch(tdb, unknown, 0);
    const w2 = upsertPrWatch(tdb, stillOpen, 0);
    const seams = sweepSeams({ [w1.id]: null, [w2.id]: { state: "open" } });
    expect(await sweepPRWatches(seams.deps)).toBe(0);
    expect(seams.started).toHaveLength(0);
    expect(getPrWatch(tdb, w1.id)).toMatchObject({ state: "open", settledAt: null });
    expect(getPrWatch(tdb, w2.id)).toMatchObject({ state: "open", settledAt: null });
    // Leave the worklist clean for later tests.
    settlePrWatch(tdb, w1.id, "closed");
    settlePrWatch(tdb, w2.id, "closed");
  });

  it("caps lookups per pass at PR_WATCH_CAP, oldest first", async () => {
    const base = watchFixture({ number: 700 });
    const watches: PRWatch[] = [];
    for (let i = 0; i < PR_WATCH_CAP + 1; i += 1) {
      // openedAt below every other fixture's so the cap list is exactly
      // these rows, oldest first.
      watches.push(upsertPrWatch(tdb, { ...base, number: 700 + i }, 1 + i));
    }
    const seams = sweepSeams(
      Object.fromEntries(watches.map((w) => [w.id, { state: "open" as const }])) as Record<
        string,
        { state: "open" | "merged" | "closed" }
      >,
    );
    await sweepPRWatches(seams.deps);
    expect(seams.asked).toEqual(watches.slice(0, PR_WATCH_CAP).map((w) => w.id));
    for (const w of watches) settlePrWatch(tdb, w.id, "closed"); // leave the worklist clean
  });

  it("PR_WATCH=off skips the pass entirely", async () => {
    expect(prWatchEnabled("off")).toBe(false);
    expect(prWatchEnabled(undefined)).toBe(true);
    const input = watchFixture({ number: 66 });
    const watch = upsertPrWatch(tdb, input, 0);
    const seams = sweepSeams({ [watch.id]: { state: "merged" } });
    seams.deps.prWatch = "off";
    expect(await sweepPRWatches(seams.deps)).toBe(0);
    expect(seams.asked).toHaveLength(0);
    expect(getPrWatch(tdb, watch.id)).toMatchObject({ state: "open", settledAt: null });
    settlePrWatch(tdb, watch.id, "closed"); // leave the worklist clean
  });

  it("renders a forgejo wake with /pulls/<n> (github stays /pull/<n>)", () => {
    const forgejo = upsertPrWatch(tdb, watchFixture({ baseUrl: "https://git.crussell.io", number: 7 }), 0);
    expect(renderWake(prWakeEvent(forgejo, { state: "closed" }))).toContain(
      "git.crussell.io/chad-russell/sweatshop/pulls/7",
    );
    settlePrWatch(tdb, forgejo.id, "closed"); // leave the worklist clean
  });

  it("a trashed parent settles silently — gone, never retried", async () => {
    const input = watchFixture({ number: 67 });
    const watch = upsertPrWatch(tdb, input, 0);
    tdb.update(conversations).set({ trashedAt: 1 }).where(eq(conversations.id, input.conversationId)).run();
    const seams = sweepSeams({ [watch.id]: { state: "merged" } });
    expect(await sweepPRWatches(seams.deps)).toBe(0); // gone ≠ woke
    expect(seams.started).toHaveLength(0);
    expect(getPrWatch(tdb, watch.id)!.state).toBe("merged"); // settled: no retry loop
    expect(await sweepPRWatches(seams.deps)).toBe(0);
  });

  it("contains a failing wake without starving the rest", async () => {
    const bad = watchFixture({ number: 68 });
    const good = watchFixture({ number: 69 });
    const badWatch = upsertPrWatch(tdb, bad, 0);
    const goodWatch = upsertPrWatch(tdb, good, 0);
    const seams = sweepSeams({ [badWatch.id]: { state: "merged" }, [goodWatch.id]: { state: "merged" } });
    const woke: string[] = [];
    seams.deps.wake = async (conversationId) => {
      if (conversationId === bad.conversationId) throw new Error("boom");
      woke.push(conversationId);
      return "started";
    };
    expect(await sweepPRWatches(seams.deps)).toBe(1); // good delivered past bad's throw
    expect(woke).toEqual([good.conversationId]);
    // bad still settled (its wake is the accepted crash-window loss —
    // the exactly-once trade, never a retry loop).
    expect(getPrWatch(tdb, badWatch.id)!.state).toBe("merged");
    expect(getPrWatch(tdb, goodWatch.id)!.state).toBe("merged");
  });
});
