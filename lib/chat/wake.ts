import { getRun as getWorkflowRun } from "workflow/api";
import { db, type Db } from "@/db";
import {
  enqueueSteer,
  getActiveRun,
  getChatChild,
  getConversation,
  lastAssistantText,
  listWakableChatChildren,
  markChatChildWoken,
  setActiveRun,
  type ChatChild,
  type RunEventMeta,
} from "@/db/chat";
import {
  listStageRuns,
  markRunWoken,
  SETTLED_STATUSES,
  type RunView,
} from "@/db/machines";
import { clipText } from "@/lib/machines/brief";
import { ACTIVE_RUN_STATUSES, startChatTurn } from "@/lib/chat/start-turn";

/**
 * 0022: the wake primitive. When a child (machine run, later a harness
 * call) settles, its parent conversation is nudged through exactly the
 * path a human send takes — mid-turn the message queues as steer
 * (drained between slices), idle it starts a new turn. The wake message
 * is a user-role row whose text is the model input and whose
 * `metadata.runEvent` renders as a transcript chip (0015 viewing-note
 * treatment): it must never read as Chad's own words.
 *
 * Idempotency: callers stamp the child's `woken_settled_at` AFTER the
 * wake fires — a crash in between at worst duplicates a message (the
 * tick sweep re-fires), never loses one. `sweepWakes` is that sweep, and
 * the recover path for wakes lost to a restart.
 *
 * Server-only (workflow runtime + sqlite). The seams exist so tests
 * never need the workflow runtime.
 */

/** One settled child, rendered into the parent's thread. */
export interface WakeEvent {
  kind: "machine" | "harness" | "thread";
  /** mr_… / hc_… / c_… — for inspect/cancel. */
  id: string;
  /** Machine name, the harness kind ("pi" / "claude"), or the child
   *  thread's playbook ("review" — "thread" when it has none). */
  name: string;
  /** completed | failed | needs-attention | waiting. */
  status: string;
  /** Clipped outcome (completed) or reason; absent for terse events. */
  detail?: string | null;
  /** Where to look: /r/<id>, /h/<kind>/<conversationId>, or /c/<id>. */
  url: string;
}

export interface WakeDeps {
  /** Test seam: live-turn status of a workflow run id. */
  statusOf?: (runId: string) => Promise<string>;
  /** Test seam: the idle-path turn starter. */
  start?: (
    conversationId: string,
    text: string,
    runEvent: RunEventMeta,
  ) => Promise<unknown>;
}

const STATUS_WORD: Record<string, string> = {
  completed: "finished",
  failed: "failed",
  "needs-attention": "needs attention",
  waiting: "waiting for your input",
};

/** The message the model sees (and the row text). Short and standalone. */
export function renderWake(event: WakeEvent): string {
  const word = STATUS_WORD[event.status] ?? event.status;
  const head =
    event.kind === "machine"
      ? `[run ${word}] ${event.name}: ${event.status}`
      : `[${event.name} ${word}]`;
  const lines = [`${head} — ${event.url}`];
  if (event.detail) lines.push("", event.detail);
  return lines.join("\n");
}

/** One wake per conversation at a time (steer-or-start must not race). */
const locks = new Map<string, Promise<unknown>>();
async function withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(conversationId) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  locks.set(conversationId, next);
  try {
    return await next;
  } finally {
    if (locks.get(conversationId) === next) locks.delete(conversationId);
  }
}

export async function wakeConversation(
  conversationId: string,
  event: WakeEvent,
  deps: WakeDeps = {},
): Promise<"steered" | "started" | "gone"> {
  return withConversationLock(conversationId, async () => {
    const conversation = getConversation(db(), conversationId);
    // Deleted parents drop out via the FK; a trashed one is not worth
    // waking (the sweep would retry forever, so callers mark it woken).
    if (!conversation || conversation.trashedAt) return "gone";

    const active = getActiveRun(db(), conversationId);
    if (active) {
      const statusOf = deps.statusOf ?? ((runId: string) => getWorkflowRun(runId).status);
      if (ACTIVE_RUN_STATUSES.has(await statusOf(active))) {
        enqueueSteer(db(), conversationId, renderWake(event));
        return "steered";
      }
      setActiveRun(db(), conversationId, null); // stale row, like the route's sweep
    }
    const start =
      deps.start ??
      (async (id: string, text: string, meta: RunEventMeta) => {
        await startChatTurn(id, text, undefined, meta);
      });
    await start(conversationId, renderWake(event), {
      kind: event.kind,
      id: event.id,
      status: event.status,
    });
    return "started";
  });
}

/** The wake event for a settled machine run (detail from its visits). */
export function runWakeEvent(run: RunView, detail: string | null): WakeEvent {
  return {
    kind: "machine",
    id: run.id,
    name: run.machineName,
    status: run.status,
    detail: detail ? clipText(detail, 500) : null,
    url: `/r/${run.id}`,
  };
}

/** A completed run's detail: its last completed visit's outcome. */
function runOutcomeDetail(database: Db, run: RunView): string | null {
  if (run.status !== "completed") {
    if (run.status === "waiting") {
      const stage = run.currentStage ? `"${run.currentStage}"` : "a stage";
      return `The run is parked at ${stage} waiting for your answer — /inbox.`;
    }
    return run.error ?? null;
  }
  const visits = listStageRuns(database, run.id);
  const last = [...visits].reverse().find((v) => v.status === "completed" && v.outcome);
  return last?.outcome ?? null;
}

/**
 * Wake a run's parent if its latest settle is undelivered. Returns
 * "none" (nothing to do — no parent / not settled), "skipped" (already
 * woken, or the parent is gone), "woke" (message delivered).
 */
export async function wakeRunIfDue(
  run: RunView,
  deps: WakeDeps = {},
): Promise<"woke" | "skipped" | "none"> {
  if (!run.parentConversationId) return "none";
  if (!SETTLED_STATUSES.has(run.status) || run.settledAt == null) return "none";
  if ((run.wokenSettledAt ?? -1) >= run.settledAt) return "skipped";
  const outcome = await wakeConversation(
    run.parentConversationId,
    runWakeEvent(run, runOutcomeDetail(db(), run)),
    deps,
  );
  if (outcome === "gone") {
    markRunWoken(db(), run.id, run.settledAt);
    return "skipped";
  }
  markRunWoken(db(), run.id, run.settledAt);
  return "woke";
}

/**
 * Deliver every unwoken settle — machine runs, harness calls, and child
 * chats (the tick's sweep; also the restart recovery). Errors are
 * contained per child — one bad parent must not starve the rest.
 */
export async function sweepWakes(deps: WakeDeps = {}): Promise<number> {
  const [{ listWakableRuns }, { listWakableCalls }] = await Promise.all([
    import("@/db/machines"),
    import("@/db/harness-calls"),
  ]);
  let woke = 0;
  for (const run of listWakableRuns(db())) {
    try {
      if ((await wakeRunIfDue(run, deps)) === "woke") woke += 1;
    } catch (err) {
      console.error(`[wake-sweep] ${run.id}:`, err);
    }
  }
  for (const call of listWakableCalls(db())) {
    try {
      if ((await wakeCallIfDue(call, deps)) === "woke") woke += 1;
    } catch (err) {
      console.error(`[wake-sweep] ${call.id}:`, err);
    }
  }
  for (const child of listWakableChatChildren(db())) {
    try {
      if ((await wakeChatChildIfDue(child, deps)) === "woke") woke += 1;
    } catch (err) {
      console.error(`[wake-sweep] ${child.id}:`, err);
    }
  }
  return woke;
}

/**
 * 0022 cut 2: wake a harness call's conversation if its settle is
 * undelivered. The call's conversation is its parent by construction.
 */
export async function wakeCallIfDue(
  call: { id: string; conversationId: string; kind: string; status: string; settledAt: number | null; wokenSettledAt: number | null; result: string | null; error: string | null },
  deps: WakeDeps = {},
): Promise<"woke" | "skipped" | "none"> {
  const { CALL_SETTLED_STATUSES, markCallWoken } = await import("@/db/harness-calls");
  if (call.settledAt == null || !CALL_SETTLED_STATUSES.has(call.status)) return "none";
  if ((call.wokenSettledAt ?? -1) >= call.settledAt) return "skipped";
  const outcome = await wakeConversation(
    call.conversationId,
    {
      kind: "harness",
      id: call.id,
      name: call.kind,
      status: call.status,
      detail: call.status === "failed" ? (call.error ?? null) : call.result,
      url: `/h/${call.kind}/${call.conversationId}`,
    },
    deps,
  );
  markCallWoken(db(), call.id, call.settledAt);
  return outcome === "gone" ? "skipped" : "woke";
}

/**
 * 0037 phase 3: wake a child chat's parent when the child settles —
 * the same primitive runs and harness calls use, with the child's own
 * settle bookkeeping. "Settled" = no live turn and message updates the
 * parent has not been told about (updatedAt is the settle reference;
 * setConversationParent pre-stamps woken so the creation bump never
 * counts). The child's last assistant text rides the wake — for a
 * review thread that IS the deliverable. Cancelled children never wake
 * (the cancel path stamps woken itself).
 */
export async function wakeChatChildIfDue(
  child: ChatChild,
  deps: WakeDeps = {},
): Promise<"woke" | "skipped" | "none"> {
  if (!child.parentConversationId) return "none";
  const statusOf = deps.statusOf ?? ((runId: string) => getWorkflowRun(runId).status);
  let status = "completed";
  if (child.activeRunId) {
    const runStatus = await statusOf(child.activeRunId);
    if (ACTIVE_RUN_STATUSES.has(runStatus)) return "none"; // still working
    if (runStatus === "cancelled") {
      // A cancel that crashed before stamping — cancelled never wakes.
      setActiveRun(db(), child.id, null);
      markChatChildWoken(db(), child.id, child.updatedAt);
      return "skipped";
    }
    if (runStatus === "failed") status = "failed";
    setActiveRun(db(), child.id, null); // stale, like the route's sweep
  }
  if ((child.wokenSettledAt ?? -1) >= child.updatedAt) return "skipped";
  const last = lastAssistantText(db(), child.id);
  // No turn ever produced output (start_thread failed to start, or the
  // turn died before its first slice) — nothing to report. Stamp woken
  // so the sweep stops re-reading it; a later human/child turn that
  // lands messages makes it due again.
  if (status === "completed" && last == null) {
    markChatChildWoken(db(), child.id, child.updatedAt);
    return "skipped";
  }
  const outcome = await wakeConversation(
    child.parentConversationId,
    {
      kind: "thread",
      id: child.id,
      name: child.playbook ?? "thread",
      status,
      detail: last ? clipText(last, 500) : null,
      url: `/c/${child.id}`,
    },
    deps,
  );
  markChatChildWoken(db(), child.id, child.updatedAt);
  return outcome === "gone" ? "skipped" : "woke";
}

/** Read the child fresh (the turn-end path) and wake if due. */
export async function wakeChatChildByIdIfDue(
  conversationId: string,
  deps: WakeDeps = {},
): Promise<"woke" | "skipped" | "none"> {
  const child = getChatChild(db(), conversationId);
  if (!child) return "none";
  return wakeChatChildIfDue(child, deps);
}
