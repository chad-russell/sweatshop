import { getRun as getWorkflowRun } from "workflow/api";
import { db } from "@/db";
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
import { markCallWoken, CALL_SETTLED_STATUSES } from "@/db/harness-calls";
import type { HarnessCall } from "@/db/schema";
import { ACTIVE_RUN_STATUSES, startChatTurn } from "@/lib/chat/start-turn";

/**
 * 0022: the wake primitive. When a child settles — a background harness
 * call (hc_…) or a child thread (c_…, 0037 phase 3) — the conversation
 * that started it is nudged through exactly the path a human send
 * takes: mid-turn the message queues as steer (drained between slices),
 * idle it starts a new turn. The wake message is a user-role row whose
 * text is the model input and whose `metadata.runEvent` renders as a
 * transcript chip (0015 viewing-note treatment): it must never read as
 * Chad's own words. (Machine runs also woke parents; the interpreter
 * was deleted by 0037 phase 5 — historical rows never settle again.)
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
  kind: "harness" | "thread";
  /** hc_… / c_… — for inspect/cancel. */
  id: string;
  /** The harness kind ("pi" / "claude" / "cursor") or the child thread's skill
   *  ("review" — "thread" when it has none). */
  name: string;
  /** completed | failed | needs-attention | waiting. */
  status: string;
  /** Clipped outcome (completed) or reason; absent for terse events. */
  detail?: string | null;
  /** Where to look: /h/<kind>/<conversationId> or /c/<id>. */
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

/** Clip a wake's detail (was lib/machines/brief — deleted in phase 5). */
export function clipText(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}\n…[clipped ${text.length - max} chars]` : text;
}

/** The message the model sees (and the row text). Short and standalone. */
export function renderWake(event: WakeEvent): string {
  const word = STATUS_WORD[event.status] ?? event.status;
  const lines = [`[${event.name} ${word}] — ${event.url}`];
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

/**
 * Deliver every unwoken settle — harness calls and child chats (the
 * tick's sweep; also the restart recovery). Errors are contained per
 * child — one bad parent must not starve the rest.
 */
export async function sweepWakes(deps: WakeDeps = {}): Promise<number> {
  const { listWakableCalls } = await import("@/db/harness-calls");
  let woke = 0;
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
  call: HarnessCall,
  deps: WakeDeps = {},
): Promise<"woke" | "skipped" | "none"> {
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
 * the same primitive harness calls use, with the child's own
 * bookkeeping. "Settled" = no live turn and message updates the
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
      name: child.skill ?? "thread",
      status,
      // Wider than harness calls: for a review thread the final
      // message IS the deliverable, and the smoke run showed 500 chars
      // truncating it mid-findings. The rest is one inspect away.
      detail: last ? clipText(last, 2000) : null,
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
