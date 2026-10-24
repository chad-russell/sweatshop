import { db } from "@/db";
import { listOpenPrWatches, settlePrWatch } from "@/db/pr-watches";
import type { PRWatch } from "@/db/schema";
import { wakeConversation, type WakeDeps, type WakeEvent } from "@/lib/chat/wake";
import type { PRState } from "@/lib/git-hosts";
import { livePRState } from "@/lib/prs/state";

/**
 * 0084: the wake sweep's PR pass — poll still-open pr_watches through
 * the same credential seam GET /api/x/prs uses, settle merged/closed
 * transitions, and wake the opening conversation through exactly the
 * path a child settle takes (lib/chat/wake.ts): idle starts a turn,
 * live queues as steer, the message is a runEvent user row rendered as
 * a transcript chip — never Chad's words.
 *
 * Exactly-once per transition: the settle is conditional on
 * state='open', so under a double sweep only the winner wakes (the
 * deterministic id plus terminal states mean a settled row is never
 * re-listed). The deliberate trade: a crash between a won settle and
 * its wake loses that one wake (the row stays settled; the state is
 * still visible in the UI) rather than risking a duplicate turn start.
 *
 * Server-only (sqlite + the host seam + the workflow runtime behind
 * wakeConversation); deps exist so tests never touch any of them.
 */

/** Lookups per pass (~10 per 30 s worst case, per the doc). */
export const PR_WATCH_CAP = 10;

/** `PR_WATCH=off` disables just this pass (checked per pass, at run
 *  time — the value seam is injectable for tests). */
export function prWatchEnabled(prWatch?: string): boolean {
  return prWatch !== "off";
}

export interface PRWatchDeps extends WakeDeps {
  /** Test seam: one watch's live state (defaults to the credential
   *  seam — lib/prs/state livePRState). */
  stateOf?: (watch: PRWatch) => Promise<PRState | null>;
  /** Test seam: the wake delivery (defaults to wakeConversation with
   *  the rest of deps threaded through). */
  wake?: (conversationId: string, event: WakeEvent, deps: WakeDeps) => Promise<"steered" | "started" | "gone">;
  /** Test seam for PR_WATCH=off (the raw value). */
  prWatch?: string;
}

/** The wake event for one settled watch — the text cites the PR. */
export function prWakeEvent(watch: PRWatch, state: PRState): WakeEvent {
  return {
    kind: "pr",
    id: watch.id,
    name: "pr",
    status: state.state,
    detail: `#${watch.number} ${state.state} (${watch.owner}/${watch.repo})`,
    url: `${watch.baseUrl}/${watch.owner}/${watch.repo}/pull/${watch.number}`,
  };
}

/** One pass: settle what settled, wake each winner's chat once.
 *  Errors are contained per watch — one bad PR must not starve the
 *  rest (same posture as sweepWakes). */
export async function sweepPRWatches(deps: PRWatchDeps = {}): Promise<number> {
  if (!prWatchEnabled(deps.prWatch ?? process.env.PR_WATCH)) return 0;
  const stateOf =
    deps.stateOf ??
    ((watch: PRWatch) =>
      livePRState({
        host: watch.baseUrl.replace(/^https?:\/\//, "").toLowerCase(),
        owner: watch.owner,
        repo: watch.repo,
        number: watch.number,
      }));
  const wake =
    deps.wake ?? ((conversationId: string, event: WakeEvent, d: WakeDeps) => wakeConversation(conversationId, event, d));
  let woke = 0;
  for (const watch of listOpenPrWatches(db(), PR_WATCH_CAP)) {
    try {
      const state = await stateOf(watch);
      // Unknown (null) or unchanged — never settle on a guess.
      if (!state || state.state === "open") continue;
      if (!settlePrWatch(db(), watch.id, state.state)) continue; // another pass won it
      const outcome = await wake(watch.conversationId, prWakeEvent(watch, state), deps);
      if (outcome !== "gone") woke += 1; // gone = trashed parent: settled, never retried
    } catch (err) {
      console.error(`[pr-watch] ${watch.id}:`, err);
    }
  }
  return woke;
}
