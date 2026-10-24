import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./index";
import { prWatches } from "./schema";
import type { PRWatch } from "./schema";

/**
 * 0084: the pr_watches store — one row per PR a chat opened through
 * create_pr, settled by the wake sweep's PR pass when the host reports
 * merged/closed. Mirrors db/harness-calls.ts: identity helpers here,
 * delivery (the wake) in lib/chat/wake.ts + lib/prs/sweep.ts.
 */

/** "merged" | "closed" — the terminal states a sweep settle writes. */
export type PRWatchSettleState = "merged" | "closed";

/**
 * Deterministic watch id: `prw_` + first 12 hex of sha1 over the PR's
 * full coordinates (origin-qualified owner/repo#number). Re-watching
 * the same PR — a create_pr retry, a sweep after a crash — maps to the
 * same row, so registration is idempotent and a settle can never
 * double-wake.
 */
export function prWatchId(baseUrl: string, owner: string, repo: string, number: number): string {
  const hash = createHash("sha1").update(`${baseUrl} ${owner}/${repo}#${number}`).digest("hex");
  return `prw_${hash.slice(0, 12)}`;
}

export function getPrWatch(db: Db, id: string): PRWatch | null {
  return db.select().from(prWatches).where(eq(prWatches.id, id)).get() ?? null;
}

export function getPrWatchByCoords(
  db: Db,
  baseUrl: string,
  owner: string,
  repo: string,
  number: number,
): PRWatch | null {
  return getPrWatch(db, prWatchId(baseUrl, owner, repo, number));
}

/**
 * Register a watch (create_pr's success path — the only writer).
 * Insert-only on conflict, deliberately: hosts number PRs once, so a
 * row for these coordinates existing at all means THIS PR — an
 * already-settled row (merged/closed) can never be reopened by
 * re-registration, and an open one needs nothing. Strictly safer than
 * an onConflictDoUpdate guarded on state, which could only ever be a
 * no-op here.
 */
export function upsertPrWatch(
  db: Db,
  input: {
    conversationId: string;
    baseUrl: string;
    owner: string;
    repo: string;
    number: number;
  },
  now = Date.now(),
): PRWatch {
  const id = prWatchId(input.baseUrl, input.owner, input.repo, input.number);
  db.insert(prWatches)
    .values({
      id,
      conversationId: input.conversationId,
      baseUrl: input.baseUrl,
      owner: input.owner,
      repo: input.repo,
      number: input.number,
      state: "open",
      openedAt: now,
    })
    .onConflictDoNothing()
    .run();
  return getPrWatch(db, id)!;
}

/**
 * Settle open → merged/closed (the sweep). Conditional on
 * `state = 'open'` so exactly one settler wins under a double sweep or
 * a crash-retry: the winner wakes the conversation, losers see false
 * and stay silent. Terminal states never move again.
 */
export function settlePrWatch(
  db: Db,
  id: string,
  state: PRWatchSettleState,
  now = Date.now(),
): boolean {
  const changes = db
    .update(prWatches)
    .set({ state, settledAt: now })
    .where(and(eq(prWatches.id, id), eq(prWatches.state, "open")))
    .run().changes;
  return changes > 0;
}

/** The sweep's worklist: still-open watches, longest-waiting first. */
export function listOpenPrWatches(db: Db, limit: number): PRWatch[] {
  return db
    .select()
    .from(prWatches)
    .where(eq(prWatches.state, "open"))
    .orderBy(asc(prWatches.openedAt))
    .limit(limit)
    .all();
}
