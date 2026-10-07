import { getRun as getWorkflowRun } from "workflow/api";
import { db } from "@/db";
import { getRun, MachineError } from "@/db/machines";
import { getHarnessCall, settleHarnessCall } from "@/db/harness-calls";
import { recordHarnessRunEnd } from "@/lib/harness-events";
import { cancelRun } from "@/lib/machines/runs";

/**
 * 0022: the cancel_run tool's core — the agent surface of cancelRun
 * (the run view's button is the human one). Handles machine runs
 * (mr_…) and background harness calls (hc_…). Value-shaped errors so
 * the model reads and repairs instead of the tool call failing.
 */

export type CancelRunResult =
  | { ok: true; runId: string; status: "cancelled"; note: string }
  | { ok: false; code: "not-found" | "not-live"; message: string };

export async function cancelRunTool(runId: string): Promise<CancelRunResult> {
  if (runId.startsWith("hc_")) return cancelHarnessCall(runId);

  let run;
  try {
    run = getRun(db(), runId);
  } catch (err) {
    if (err instanceof MachineError && err.code === "not-found") {
      return { ok: false, code: "not-found", message: `no run ${runId}` };
    }
    throw err;
  }
  if (run.status !== "running" && run.status !== "waiting") {
    return {
      ok: false,
      code: "not-live",
      message: `run ${runId} is already ${run.status} — only running/waiting runs can be cancelled`,
    };
  }
  await cancelRun(runId, "cancelled by cancel_run tool");
  return {
    ok: true,
    runId,
    status: "cancelled",
    note: "the run's sandbox and work are kept (inspect it as usual)",
  };
}

/**
 * Cancel a background harness call: stop its workflow, settle the call
 * (cancelled never wakes), and release the one-per-session slot. A
 * racing natural settle loses to the first final write (both settle
 * paths are running-only).
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
  if (call.workflowRunId) {
    const workflow = getWorkflowRun(call.workflowRunId);
    if (await workflow.exists) await workflow.cancel({ cancelReason: "cancelled by cancel_run tool" });
  }
  const settled = settleHarnessCall(db(), call.id, { status: "cancelled" });
  if (settled) {
    recordHarnessRunEnd(call.conversationId, call.kind as "pi" | "claude", 0, "cancelled", "cancelled");
  }
  return {
    ok: true,
    runId,
    status: "cancelled",
    note: `the ${call.kind} session keeps its prior context; its sandbox is untouched`,
  };
}
