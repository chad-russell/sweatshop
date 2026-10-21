import type { Db } from "@/db";
import { getHarnessCall } from "@/db/harness-calls";
import { getChatChild } from "@/db/chat";

/**
 * The status of a chat's background child — a background harness call
 * (hc_…, 0022) or a child thread (c_…, 0037 phase 3) — as its transcript
 * card shows it. One read model for both so the card, the route, and the
 * tests agree on what "live" means: `live` children are polled, settled
 * ones never change again (cancelled is final; waiting can resume, so it
 * stays live). (0048: a third kind, machine runs (mr_…), was purged —
 * `mr_…` ids now fall through to the generic not-found `null`.)
 */
export interface ChildStatus {
  id: string;
  kind: "harness" | "thread";
  status: string;
  live: boolean;
  /** Where to look closer (the harness session or the thread). */
  href: string;
  startedAt: number;
  /** Unix ms of the last settle (null while it has never settled). */
  settledAt: number | null;
  /** Where it is: a thread's skill. */
  where: string | null;
  /** 0055 v7 part B: the phase (display name) this harness call or
   *  child thread was started to do — null when the parent chat wasn't
   *  moded or had no phases. */
  phase: string | null;
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
      href: `/h/${call.kind}/${call.conversationId}/${call.id}`,
      startedAt: call.createdAt,
      settledAt: call.settledAt,
      where: null,
      phase: call.phase,
      error: clip(call.error),
    };
  }
  if (id.startsWith("mr_")) {
    // 0048: machine runs were purged — no mr_ id ever resolves again.
    return null;
  }
  if (id.startsWith("c_")) {
    // Only agent-started children (they carry a parent) are cards'
    // business; Chad's own conversations are not polled here. A chat's
    // live signal is its active turn row — cleared at settle, cancel,
    // and by the wake sweep's stale pass.
    const child = getChatChild(db, id);
    if (!child?.parentConversationId) return null;
    const live = child.activeRunId != null;
    return {
      id,
      kind: "thread",
      status: live ? "running" : "completed",
      live,
      href: `/c/${id}`,
      startedAt: child.createdAt,
      settledAt: live ? null : child.updatedAt,
      where: child.skill,
      phase: child.workPhase,
      error: null,
    };
  }
  return null;
}

function clip(text: string | null): string | null {
  if (!text) return null;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
