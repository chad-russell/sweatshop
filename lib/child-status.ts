import { asc, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { getHarnessCall } from "@/db/harness-calls";
import { getChatChild, listModelMessages } from "@/db/chat";
import { messages } from "@/db/schema";
import { renderPhaseContext } from "@/lib/chat/phase-context";
import { deriveStatus, statusChipLabel } from "@/lib/status";

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
  /** 0059: a child thread's own current status label, when it has one. */
  statusLabel: string | null;
  /** 0059: the handoff re-rendered from the harness call's stored skill
   *  version. Null for threads (their first message carries it) and for
   *  calls started with no phase. */
  phaseContext: { phase: string; text: string } | null;
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
      statusLabel: null,
      phaseContext:
        call.phaseSkillId && call.phaseSkillVersion != null && call.phaseId
          ? renderPhaseContext(db, {
              skillId: call.phaseSkillId,
              skillVersion: call.phaseSkillVersion,
              phaseId: call.phaseId,
              task: call.task,
            })
          : null,
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
      statusLabel: threadStatusLabel(db, id),
      phaseContext: null,
      error: null,
    };
  }
  return null;
}

function threadStatusLabel(db: Db, conversationId: string): string | null {
  const derived = deriveStatus(listModelMessages(db, conversationId));
  return derived.current ? (statusChipLabel(derived.current)?.label ?? null) : null;
}

/** Status labels for child threads, one query. Chats with no status are absent. */
export function childThreadStatusLabels(db: Db, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = db
    .select({ conversationId: messages.conversationId, modelMessage: messages.modelMessage })
    .from(messages)
    .where(inArray(messages.conversationId, [...ids]))
    .orderBy(asc(sql`rowid`))
    .all();
  const grouped = new Map<string, unknown[]>();
  for (const row of rows) {
    if (!row.modelMessage) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.modelMessage);
    } catch {
      continue;
    }
    const list = grouped.get(row.conversationId) ?? [];
    list.push(parsed);
    grouped.set(row.conversationId, list);
  }
  for (const id of ids) {
    const derived = deriveStatus(grouped.get(id) ?? []);
    const label = derived.current ? statusChipLabel(derived.current)?.label : null;
    if (label) out.set(id, label);
  }
  return out;
}

function clip(text: string | null): string | null {
  if (!text) return null;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
