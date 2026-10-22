import type { ModelMessage } from "ai";
import { ownerName, possessive } from "@/lib/agent/owner";
import { db } from "@/db";
import { listModelMessages } from "@/db/chat";
import {
  approveOutlineRow,
  getOutlineRow,
  openOutlineReview,
  outlineState,
  pendingAcceptOutlineIds,
  type OutlineCard,
} from "@/db/outlines";
import { deriveOutline, validateOutline, type Outline, type OutlineSnapshot } from "@/lib/outline";

/**
 * 0064: the outline tools' cores. `update_outline` rewrites the whole
 * outline (TodoWrite-style, replacing 0059's update_status) and, when
 * `propose: true`, opens a hookless review row so the Inbox shows "needs
 * you" — it never suspends: the agent keeps working and Chad's messages
 * stay ordinary messages. Approval is explicit: the outline card's button
 * (approveOutline here, then a wake) or accept_outline's own approval
 * card. Plain functions; the workflow steps are thin wrappers.
 */

type Fail = { ok: false; code: string; message: string };
const fail = (code: string, message: string): Fail => ({ ok: false, code, message });

export interface UpdateOutlineInput {
  goal?: unknown;
  steps?: unknown;
  note?: unknown;
  propose?: unknown;
}

/** Rewrite the outline (the version is the count of every prior landed
 *  rewrite — legacy update_status results included, since this picks up
 *  numbering where a thread's status left off). `live` carries this
 *  turn's earlier tool results (a turn persists only slice by slice). */
export function updateOutline(
  conversationId: string,
  toolCallId: string,
  input: UpdateOutlineInput,
  live: readonly ModelMessage[] = [],
): OutlineSnapshot | Fail {
  const parsed = validateOutline(input);
  if ("ok" in parsed) return fail(parsed.code, parsed.message);
  const outline: Outline = parsed;
  const propose = input.propose === true;
  const priorHistory = deriveOutline([...listModelMessages(db(), conversationId), ...live]).history.length;
  const version = priorHistory + 1;
  if (propose) {
    const card: OutlineCard = { kind: "outline", version, outline, ...(outline.note ? { note: outline.note } : {}) };
    openOutlineReview(db(), { id: toolCallId, conversationId, card });
  }
  return {
    ok: true,
    version,
    outline,
    proposed: propose,
    next: propose
      ? `Outline v${version} is on ${possessive()} screen for review — keep working, it never blocks. Approval arrives as ` +
        "an [outline approved] message (or call accept_outline when they say so in chat)."
      : `Outline v${version} recorded.`,
  };
}

/** accept_outline's preview: the open review it would approve. */
export function acceptOutlinePreview(
  conversationId: string,
): { ok: true; rowId: string; card: OutlineCard; summary: string } | Fail {
  const state = outlineState(db(), conversationId);
  if (state.kind === "none") return fail("no-review", "no outline is in review — update_outline with propose: true first");
  if (state.kind === "approved") return fail("already-approved", "the latest outline is already approved — carry on");
  const card = state.row.card;
  if (!card) return fail("no-review", "the open review has no snapshot — propose again");
  return {
    ok: true,
    rowId: state.row.id,
    card,
    summary: `Approve outline v${card.version}${card.note ? ` — ${card.note}` : ""}?`,
  };
}

/** accept_outline approved by Chad: resolve the review it named. */
export function acceptOutlineApproved(
  rowId: string,
  comment?: string,
): { approved: true; version: number; message: string } | Fail {
  const row = getOutlineRow(db(), rowId);
  if (!row) return fail("no-review", "that review is gone");
  if (!approveOutlineRow(db(), rowId, comment) && row.answer?.approved !== true) {
    return fail("superseded", "a newer outline replaced that review — update_outline is the current one; ask again");
  }
  const v = row.card?.version ?? 0;
  return {
    approved: true,
    version: v,
    message: `${ownerName()} approved outline v${v}${comment ? `: ${comment}` : ""}.`,
  };
}

export type ApproveOutlineResult =
  | { ok: true; version: number; delivered: "accept_outline" | "wake" }
  | { ok: false; status: 404 | 409; error: string };

export interface ApproveOutlineDeps {
  /** Answer a suspended accept_outline (resume its hook). */
  resume: (token: string, payload: { kind: "approval"; approved: true; comment?: string }) => Promise<unknown>;
  /** Wake the conversation with the approval. */
  wake: (conversationId: string, version: number, rowId: string, note?: string) => Promise<unknown>;
}

/**
 * The outline card's Approve. Resolves the open review (refused when it
 * was superseded or already answered — "v4 is current"), then tells the
 * agent: a suspended accept_outline is answered directly (the turn is
 * waiting on it — a wake would duplicate), otherwise a wake (0022).
 */
export async function approveOutline(rowId: string, note: string | undefined, deps: ApproveOutlineDeps): Promise<ApproveOutlineResult> {
  const row = getOutlineRow(db(), rowId);
  if (!row) return { ok: false, status: 404, error: "no such outline review" };
  if (row.resolvedAt !== null) {
    const latest = outlineState(db(), row.conversationId);
    const current = latest.kind === "review" ? latest.row.card?.version : undefined;
    return {
      ok: false,
      status: 409,
      error: row.answer?.approved
        ? "this outline is already approved"
        : current
          ? `a newer version is current — approve v${current}`
          : "this outline version was replaced",
    };
  }
  if (!approveOutlineRow(db(), rowId, note)) return { ok: false, status: 409, error: "this outline was answered already" };
  const version = row.card?.version ?? 0;
  const waiting = pendingAcceptOutlineIds(db(), row.conversationId);
  if (waiting.length > 0) {
    const { resolvePendingInput } = await import("@/db/chat");
    for (const id of waiting) {
      const payload = { kind: "approval" as const, approved: true as const, ...(note ? { comment: note } : {}) };
      try {
        await deps.resume(id, payload);
      } catch {
        // already answered elsewhere — the row below records ours anyway
      }
      resolvePendingInput(db(), id, payload);
    }
    return { ok: true, version, delivered: "accept_outline" };
  }
  await deps.wake(row.conversationId, version, rowId, note);
  return { ok: true, version, delivered: "wake" };
}
