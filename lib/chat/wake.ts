import { getRun as getWorkflowRun } from "workflow/api";
import { db } from "@/db";
import {
  enqueueSteer,
  getActiveRun,
  getChatChild,
  getConversation,
  lastAssistantReport,
  listModelMessages,
  listWakableChatChildren,
  markChatChildWoken,
  setActiveRun,
  type ChatChild,
  type RunEventMeta,
} from "@/db/chat";
import { markCallWoken, CALL_SETTLED_STATUSES } from "@/db/harness-calls";
import type { HarnessCall } from "@/db/schema";
import { ACTIVE_RUN_STATUSES, startChatTurn } from "@/lib/chat/start-turn";
import { activeStepLabel, deriveOutline, outlineChip } from "@/lib/outline";
import { saveResultFile, type NoResultFileReason } from "@/lib/chat/result-file";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

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
  /** 0041: "plan" = Chad approved the plan in review (id = the review row).
   *  0064: "outline" = Chad approved the outline in review, same shape.
   *  0084: "pr" = a watched PR merged/closed on its host (id = the
   *  pr_watches row; the detail cites "#N merged (owner/repo)"). */
  kind: "harness" | "thread" | "plan" | "outline" | "pr";
  /** hc_… / c_… — for inspect/cancel. */
  id: string;
  /** The harness kind ("pi" / "claude" / "cursor" / "codex"), or "thread" for a child thread. */
  name: string;
  /** completed | failed | ran out of steps | needs-attention | waiting. */
  status: string;
  /** Clipped outcome (completed) or reason; absent for terse events. */
  detail?: string | null;
  /** 0059: the parent's active status step, when it has one. */
  step?: string | null;
  /** 0059: a child thread's own status label at settle. */
  childStatus?: string | null;
  /** Where to look: /h/<kind>/<conversationId>/<callId> or /c/<id>. */
  url: string;
  /** 0040 phase 3: the FULL result's size and where it was saved — present
   *  whenever there is a full result to report (harness/thread settles
   *  with real content), absent for everything else (plan events, a
   *  child that never produced output). `file` is null when nothing was
   *  saved; `reason` says why (unbound vs. write-failed) when known — the
   *  sweep path for a harness call only has the persisted path, never the
   *  reason, so it is absent there (review fix: never guess one). */
  result?: { chars: number; file: string | null; reason?: NoResultFileReason };
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
  /** Test seam: the sandbox provider behind the result-file write
   *  (lib/chat/result-file.ts) — same seam as loadRepoDocs. */
  resultFileProvider?: SandboxProvider;
}

/** 0040 phase 3: how much of a full result rides inline on the wake
 *  message before it defers to the saved file — shared by harness and
 *  thread wakes (was 500 / 2 000 respectively). About 4k tokens: enough
 *  for any review or summary seen so far, still bounded if a child
 *  dumps a log. */
export const WAKE_DETAIL_CAP = 16_000;

const STATUS_WORD: Record<string, string> = {
  completed: "finished",
  failed: "failed",
  "ran out of steps": "ran out of steps",
  "needs-attention": "needs attention",
  waiting: "waiting for your input",
};

/** Clip a wake's detail (was lib/machines/brief — deleted in phase 5).
 *  Points at the full-result file when one was saved, else inspect. */
export function clipText(text: string | null | undefined, max: number, pointer?: { id: string; file: string | null }): string {
  if (!text) return "";
  if (text.length <= max) return text;
  const cut = text.length - max;
  const where = pointer
    ? pointer.file
      ? ` — full result: ${pointer.file}`
      : ` — no file saved; inspect ${pointer.id}`
    : "";
  return `${text.slice(0, max)}\n…[${cut} more chars${where}]`;
}

const NO_RESULT_FILE_REASON: Record<NoResultFileReason, string> = {
  unbound: "no bound sandbox",
  "write-failed": "write failed",
};

/** The message the model sees (and the row text). Short and standalone. */
export function renderWake(event: WakeEvent): string {
  const word = STATUS_WORD[event.status] ?? event.status;
  const lines = [`[${event.name} ${word}] — ${event.url}`];
  if (event.step) lines.push("", `current step: ${event.step}`);
  if (event.childStatus) lines.push(`child status: ${event.childStatus}`);
  if (event.detail) lines.push("", event.detail);
  if (event.result) {
    const reason = event.result.reason ? ` (${NO_RESULT_FILE_REASON[event.result.reason]})` : "";
    lines.push(
      "",
      event.result.file
        ? `full result (${event.result.chars} chars): ${event.result.file} — read or grep it with bash`
        : `no result file saved${reason}`,
    );
  }
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
    const step = event.step ?? activeStepLabel(deriveOutline(listModelMessages(db(), conversationId)));
    const text = renderWake({ ...event, ...(step ? { step } : {}) });
    if (active) {
      const statusOf = deps.statusOf ?? ((runId: string) => getWorkflowRun(runId).status);
      if (ACTIVE_RUN_STATUSES.has(await statusOf(active))) {
        enqueueSteer(db(), conversationId, text);
        return "steered";
      }
      setActiveRun(db(), conversationId, null); // stale row, like the route's sweep
    }
    const start =
      deps.start ??
      (async (id: string, text: string, meta: RunEventMeta) => {
        await startChatTurn(id, text, undefined, meta);
      });
    await start(conversationId, text, {
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
 *
 * 0040 phase 3 (review fix): this is the SWEEP/recovery path — the result
 * file (if any) was already written, and its path (or null) already
 * persisted on the row, at settle time (`harnessSettleStep`). This never
 * re-derives, re-writes, or re-opens the sandbox — it reads
 * `call.resultFile` back verbatim, so it can only ever report a path that
 * really exists. It has no `reason` for a missing file (that lived only
 * in the settle-time `saveResultFile` call, not persisted) — the message
 * just says "no result file saved" with no parenthetical.
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
      detail:
        call.status === "failed"
          ? (call.error ?? null)
          : clipText(call.result, WAKE_DETAIL_CAP, { id: call.id, file: call.resultFile }),
      url: `/h/${call.kind}/${call.conversationId}/${call.id}`,
      ...(call.status === "completed" && call.result
        ? { result: { chars: call.result.length, file: call.resultFile } }
        : {}),
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
  const report = lastAssistantReport(db(), child.id);
  // No turn ever produced any REAL text (start_thread failed to start,
  // the turn died before its first slice, or ran out of steps on its
  // very first, placeholder-only step) — nothing to report. Stamp woken
  // (and clear any earlier settle's result file — it is not THIS
  // settle's) so the sweep stops re-reading it; a later human/child turn
  // that lands messages makes it due again.
  if (status === "completed" && report == null) {
    markChatChildWoken(db(), child.id, child.updatedAt);
    return "skipped";
  }
  // 0040 phase 3: the turn ended by hitting its step budget, not by the
  // model choosing to stop — distinct from both a clean finish and an
  // actual failure.
  if (status === "completed" && report?.exhausted) status = "ran out of steps";
  // 0040 phase 3 (review fix): this IS the one and only attempt at this
  // settle — the same function runs for both the in-run wake
  // (wakeParentStep) and the sweep recovery, guarded by the
  // wokenSettledAt check above, so there is no separate "settle" moment
  // to race or duplicate the write from (unlike harness calls). The
  // outcome's path (or null) is persisted below — inspect reads that
  // back, never a derived guess. A re-woken child's later report cannot
  // overwrite an earlier settle's file: the settle timestamp in the id
  // makes each one unique.
  const outcome = report
    ? await saveResultFile(child.parentConversationId, `${child.id}-${child.updatedAt}`, report.text, deps.resultFileProvider)
    : null;
  const result = outcome
    ? outcome.path === null
      ? { chars: report!.text.length, file: null, reason: outcome.reason }
      : { chars: outcome.chars, file: outcome.path }
    : undefined;
  const childDerived = deriveOutline(listModelMessages(db(), child.id));
  const childLabel = outlineChip(childDerived);
  const wakeOutcome = await wakeConversation(
    child.parentConversationId,
    {
      kind: "thread",
      id: child.id,
      name: "thread",
      status,
      ...(childLabel ? { childStatus: childLabel.label } : {}),
      // Wider than harness calls: for a review thread the final
      // message IS the deliverable, and the smoke run showed 500 chars
      // truncating it mid-findings. The rest is one inspect away.
      detail: report ? clipText(report.text, WAKE_DETAIL_CAP, { id: child.id, file: outcome?.path ?? null }) : null,
      url: `/c/${child.id}`,
      ...(result ? { result } : {}),
    },
    deps,
  );
  markChatChildWoken(db(), child.id, child.updatedAt, outcome?.path ?? null);
  return wakeOutcome === "gone" ? "skipped" : "woke";
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
