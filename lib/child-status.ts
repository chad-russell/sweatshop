import type { Db } from "@/db";
import { getHarnessCall } from "@/db/harness-calls";
import { getRun, LIVE_STATUSES, MachineError } from "@/db/machines";

/**
 * The status of a chat's background child — a machine run (mr_…) or a
 * background harness call (hc_…, 0022) — as its transcript card shows
 * it. One read model for both so the card, the route, and the tests
 * agree on what "live" means: `live` children are polled, settled ones
 * never change again (cancelled is final; waiting can resume, so it
 * stays live).
 */
export interface ChildStatus {
  id: string;
  kind: "run" | "harness";
  status: string;
  live: boolean;
  /** Where to look closer (the run view or the harness session). */
  href: string;
  startedAt: number;
  /** Unix ms of the last settle (null while it has never settled). */
  settledAt: number | null;
  /** Runs: the stage it is on (or stopped at). */
  stage: string | null;
  /** Clipped failure reason, when there is one. */
  error: string | null;
}

export function childStatus(db: Db, id: string): ChildStatus | null {
  if (id.startsWith("hc_")) {
    const call = getHarnessCall(db, id);
    if (!call) return null;
    return {
      id,
      kind: "harness",
      status: call.status,
      live: call.status === "running",
      href: `/h/${call.kind}/${call.conversationId}`,
      startedAt: call.createdAt,
      settledAt: call.settledAt,
      stage: null,
      error: clip(call.error),
    };
  }
  if (id.startsWith("mr_")) {
    let run;
    try {
      run = getRun(db, id);
    } catch (err) {
      if (err instanceof MachineError && err.code === "not-found") return null;
      throw err;
    }
    return {
      id,
      kind: "run",
      status: run.status,
      live: LIVE_STATUSES.has(run.status),
      href: `/r/${id}`,
      startedAt: run.createdAt,
      settledAt: run.settledAt,
      stage: run.currentStage,
      error: clip(run.error),
    };
  }
  return null;
}

function clip(text: string | null): string | null {
  if (!text) return null;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
