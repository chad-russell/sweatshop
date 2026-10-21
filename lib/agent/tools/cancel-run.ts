import { getRun as getWorkflowRun } from "workflow/api";
import { db } from "@/db";
import { getHarnessCall, settleHarnessCall } from "@/db/harness-calls";
import {
  getChatChild,
  markChatChildWoken,
  resolveOrphanedPendingInputs,
  setActiveRun,
} from "@/db/chat";
import { recordHarnessRunEnd } from "@/lib/harness-events";

/**
 * 0022: the cancel_run tool's core — the agent surface of cancellation.
 * Handles background harness calls (hc_…) and child threads (c_…, 0037
 * phase 3). Machine runs (mr_…) are purged (0048) — never cancellable.
 * Value-shaped errors so the model reads and repairs instead of the
 * tool call failing.
 */

export type CancelRunResult =
  | { ok: true; runId: string; status: "cancelled"; note: string }
  | { ok: false; code: "not-found" | "not-live" | "not-a-child"; message: string };

export async function cancelRunTool(runId: string): Promise<CancelRunResult> {
  if (runId.startsWith("hc_")) return cancelHarnessCall(runId);
  if (runId.startsWith("c_")) return cancelChatChild(runId);
  return {
    ok: false,
    code: "not-found",
    message: `no cancellable background work ${runId} — harness calls are hc_… and child threads c_…`,
  };
}

/**
 * Cancel a background harness call: settle it `cancelled` (never wakes)
 * and release the one-per-session slot. A racing natural settle loses
 * to the first final write (both settle paths are running-only).
 *
 * harness-bridge-cleanup: deliberately does NOT call `workflow.cancel()`
 * on the run. A cancelled Workflow DevKit run stops being replayed at
 * its next processing boundary — the SAME boundary our own
 * `harnessCallIsLiveStep` check sits at, inside the still-running
 * `harnessCall` workflow — so calling `.cancel()` would race that check
 * and, if it wins (it reliably does — `run_cancelled` is a terminal
 * event the runtime stops replaying past), the workflow body never gets
 * to run `harnessStopStep({destroy:true})` at all: exactly the leaked-
 * bridge bug this exists to fix. Settling the row HERE, and leaving the
 * run alone, is what lets the loop notice between steps and tear down
 * itself. The cost is at most one in-flight semantic step finishing
 * first — fine, and far cheaper than a leaked bridge holding a port. If
 * the run is already gone, failed, or was never started, nothing tears
 * down from inside — also fine: there is no live session left to leak.
 */
async function cancelHarnessCall(runId: string): Promise<CancelRunResult> {
  const call = getHarnessCall(db(), runId);
  if (!call) return { ok: false, code: "not-found", message: `no harness call ${runId}` };
  if (call.status !== "running") {
    return {
      ok: false,
      code: "not-live",
      message: `harness call ${runId} is already ${call.status} — only running calls can be cancelled`,
    };
  }
  const settled = settleHarnessCall(db(), call.id, { status: "cancelled" });
  if (settled) {
    recordHarnessRunEnd(call.conversationId, call.kind as "pi" | "claude" | "cursor" | "codex", 0, "cancelled", "cancelled");
  }
  return {
    ok: true,
    runId,
    status: "cancelled",
    note: `the ${call.kind} session is torn down at its next step boundary; the sandbox itself is untouched`,
  };
}

/**
 * 0037 phase 3: cancel a child thread's live turn. Only threads this
 * system started (start_thread — they carry a parent) are cancellable
 * from a chat; Chad's own conversations are not the tool's business.
 * Cancelled children never wake their parent (0022 rule), so the
 * settle is stamped delivered here.
 */
async function cancelChatChild(runId: string): Promise<CancelRunResult> {
  const child = getChatChild(db(), runId);
  if (!child) return { ok: false, code: "not-found", message: `no conversation ${runId}` };
  if (!child.parentConversationId) {
    return {
      ok: false,
      code: "not-a-child",
      message: `${runId} is not a thread started by start_thread — only child threads can be cancelled here`,
    };
  }
  if (!child.activeRunId) {
    return {
      ok: false,
      code: "not-live",
      message: `thread ${runId} has no live turn — it has already settled`,
    };
  }
  const workflow = getWorkflowRun(child.activeRunId);
  if (await workflow.exists) await workflow.cancel({ cancelReason: "cancelled by cancel_run tool" });
  setActiveRun(db(), runId, null);
  markChatChildWoken(db(), runId, child.updatedAt);
  // The cancelled run's hooks are gone: resolve the thread's pending
  // cards so they cannot outlive their hook (2026-10-13 inbox bug).
  resolveOrphanedPendingInputs(db(), runId, "cancelled");
  return {
    ok: true,
    runId,
    status: "cancelled",
    note: "the thread keeps its messages and the sandbox is untouched (its parent is not woken)",
  };
}
