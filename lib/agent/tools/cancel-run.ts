import { db } from "@/db";
import { getRun, MachineError } from "@/db/machines";
import { cancelRun } from "@/lib/machines/runs";

/**
 * 0022: the cancel_run tool's core — the agent surface of cancelRun
 * (the run view's button is the human one). Value-shaped errors so the
 * model reads and repairs instead of the tool call failing.
 *
 * Cut 2 extends this to harness calls (hc_… ids).
 */

export type CancelRunResult =
  | { ok: true; runId: string; status: "cancelled"; note: string }
  | { ok: false; code: "not-found" | "not-live"; message: string };

export async function cancelRunTool(runId: string): Promise<CancelRunResult> {
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
