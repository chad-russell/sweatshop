import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
import { conversations } from "../db/schema";
import {
  getPrWatch,
  listOpenPrWatches,
  prWatchId,
  settlePrWatch,
  upsertPrWatch,
} from "../db/pr-watches";

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
  });

  it("cascades away with its conversation", () => {
    const input = watchFixture();
    const row = upsertPrWatch(tdb, input);
    tdb.delete(conversations).where(eq(conversations.id, input.conversationId)).run();
    expect(getPrWatch(tdb, row.id)).toBeNull();
  });
});
