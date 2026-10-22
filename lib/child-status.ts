import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { getHarnessCall } from "@/db/harness-calls";
import { getChatChild } from "@/db/chat";
import { renderPhaseContext } from "@/lib/chat/phase-context";
import { deriveOutline, outlineChip } from "@/lib/outline";

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
      phase: call.step ?? call.phase,
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
      phase: child.workStep ?? child.workPhase,
      statusLabel: threadStatusLabel(db, id),
      phaseContext: null,
      error: null,
    };
  }
  return null;
}

function labelFromModelMessage(modelMessage: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(modelMessage);
  } catch {
    return null;
  }
  const derived = deriveOutline([parsed]);
  return outlineChip(derived)?.label ?? null;
}

/** The newest row per conversation whose stored message mentions
 *  `update_outline` (or legacy `update_status`, 0064 decision 10). The
 *  sidebar label is the current outline only, so one row is enough —
 *  not the whole transcript, and not staleness. `liveOnly` drops
 *  trashed and archived chats (the sidebar). */
function newestStatusRows(db: Db, ids: readonly string[], liveOnly: boolean): { conversationId: string; modelMessage: string }[] {
  if (ids.length === 0) return [];
  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const live = liveOnly ? sql`and c.trashed_at is null and c.archived_at is null` : sql``;
  return db.all<{ conversationId: string; modelMessage: string }>(sql`
    select m.conversation_id as conversationId, m.model_message as modelMessage
    from messages m
    join (
      select conversation_id as cid, max(rowid) as rid
      from messages
      where conversation_id in (${idList})
        and (model_message like '%update_outline%' or model_message like '%update_status%')
      group by conversation_id
    ) newest on m.rowid = newest.rid
    join conversations c on c.id = m.conversation_id
    where m.model_message is not null ${live}
  `);
}

function threadStatusLabel(db: Db, conversationId: string): string | null {
  const row = newestStatusRows(db, [conversationId], false)[0];
  return row ? labelFromModelMessage(row.modelMessage) : null;
}

/** Status labels for child threads, one query. Trashed and archived
 *  chats are absent. Chats with no status are absent. */
export function childThreadStatusLabels(db: Db, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of newestStatusRows(db, ids, true)) {
    const label = labelFromModelMessage(row.modelMessage);
    if (label) out.set(row.conversationId, label);
  }
  return out;
}

function clip(text: string | null): string | null {
  if (!text) return null;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
