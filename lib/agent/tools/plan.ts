import type { ModelMessage } from "ai";
import { ownerName, possessive } from "@/lib/agent/owner";
import { db } from "@/db";
import { listModelMessages } from "@/db/chat";
import {
  approvePlanRow,
  getPlanRow,
  openPlanReview,
  pendingAcceptPlanIds,
  planState,
  type PlanCard,
} from "@/db/plans";
import { openConversationSandbox } from "@/lib/sandboxes/binding";
import type { SandboxProvider } from "@/lib/sandboxes/provider";
import { PLAN_FILE, PLAN_MAX_BYTES, isPlanSnapshot, parseChecklist, type PlanSnapshot } from "@/lib/plan";

/**
 * 0041: the plan tools' cores. present_plan snapshots the scratch
 * PLAN.md (beside the checkouts, never inside a repo) into its tool
 * result — that result IS the version, the diff base and the durable
 * copy — and, before approval, opens a hookless review row so the Inbox
 * shows "needs you". It never suspends: the agent keeps working and
 * Chad's messages stay ordinary messages. Approval is explicit: the plan
 * card's button (approvePlan here, then a wake) or accept_plan's own
 * approval card. Plain functions; the workflow steps are thin wrappers.
 */

type Fail = { ok: false; code: string; message: string };
const fail = (code: string, message: string): Fail => ({ ok: false, code, message });

export interface PresentPlanInput {
  note?: string;
  reapprove?: boolean;
}

type ToolPart = { type?: string; toolName?: string; toolCallId?: string; output?: unknown };

/** Successful present_plan call ids in a message list (pure). */
export function planCallIds(list: readonly ModelMessage[]): string[] {
  const ids: string[] = [];
  for (const message of list) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as ToolPart[]) {
      if (part.type !== "tool-result" || part.toolName !== "present_plan" || !part.toolCallId) continue;
      const out = part.output as { type?: string; value?: unknown } | undefined;
      if (isPlanSnapshot(out?.type === "json" ? out.value : out)) ids.push(part.toolCallId);
    }
  }
  return ids;
}

export async function presentPlan(
  conversationId: string,
  toolCallId: string,
  input: PresentPlanInput,
  live: readonly ModelMessage[] = [],
  provider?: SandboxProvider,
): Promise<PlanSnapshot | Fail> {
  try {
    const opened = await openConversationSandbox(conversationId, provider);
    const file = `${opened.workDir.replace(/\/+$/, "")}/${PLAN_FILE}`;
    const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
    const stat = await opened.handle.run(`stat -c %s ${quoted} 2>/dev/null || echo -1`, undefined, opened.workDir);
    const size = Number(stat.stdout.trim().split("\n").pop());
    if (!Number.isFinite(size) || size < 0) {
      return fail("no-plan", `no plan at ${file} — write it there first (beside the repos, not inside one)`);
    }
    if (size > PLAN_MAX_BYTES) {
      return fail("too-large", `${file} is ${Math.round(size / 1024)} KiB; the cap is ${PLAN_MAX_BYTES / 1024} — tighten it`);
    }
    const read = await opened.handle.run(`cat ${quoted}`, undefined, opened.workDir);
    if (read.exitCode !== 0) return fail("read-failed", `could not read ${file}`);
    const markdown = read.stdout;
    if (!markdown.trim()) return fail("empty", `${file} is empty`);

    const prior = new Set([...planCallIds(listModelMessages(db(), conversationId)), ...planCallIds(live)]);
    prior.delete(toolCallId);
    const version = prior.size + 1;
    const checklist = parseChecklist(markdown);
    const note = input.note?.trim() || undefined;

    const state = planState(db(), conversationId);
    const review = input.reapprove === true || state.kind !== "approved";
    if (review) {
      const card: PlanCard = { kind: "plan", version, markdown, checklist, ...(note ? { note } : {}) };
      openPlanReview(db(), { id: toolCallId, conversationId, card });
    }
    return {
      ok: true,
      version,
      markdown,
      checklist,
      status: review ? "review" : "progress",
      ...(note ? { note } : {}),
      next: review
        ? `Plan v${version} is on ${possessive()} screen for review. Keep going: answer their messages, edit ${PLAN_FILE}, and present again. ` +
          "Do not commit on the work branch or push before the owner approves — approval arrives as a [plan approved] message " +
          "(or call accept_plan when they say so in chat)."
        : `Progress snapshot v${version} (${checklist.done}/${checklist.total}) shown; the plan stays approved.`,
    };
  } catch (err) {
    return fail("failed", err instanceof Error ? err.message : String(err));
  }
}

/** accept_plan's preview: the open review it would approve. */
export function acceptPlanPreview(
  conversationId: string,
): { ok: true; rowId: string; card: PlanCard; summary: string } | Fail {
  const state = planState(db(), conversationId);
  if (state.kind === "none") return fail("no-review", "no plan is in review — present_plan first");
  if (state.kind === "approved") return fail("already-approved", "the latest plan is already approved — carry on building");
  const card = state.row.card;
  if (!card) return fail("no-review", "the open review has no snapshot — present_plan again");
  return {
    ok: true,
    rowId: state.row.id,
    card,
    summary: `Approve plan v${card.version}${card.note ? ` — ${card.note}` : ""}?`,
  };
}

/** accept_plan approved by Chad: resolve the review it named. */
export function acceptPlanApproved(
  rowId: string,
  comment?: string,
): { approved: true; version: number; message: string } | Fail {
  const row = getPlanRow(db(), rowId);
  if (!row) return fail("no-review", "that review is gone");
  if (!approvePlanRow(db(), rowId, comment) && row.answer?.approved !== true) {
    return fail("superseded", "a newer plan version replaced that review — present_plan is the current one; ask again");
  }
  const v = row.card?.version ?? 0;
  return {
    approved: true,
    version: v,
    message: `${ownerName()} approved plan v${v}${comment ? `: ${comment}` : ""}. Start building from ${PLAN_FILE}.`,
  };
}

export type ApprovePlanResult =
  | { ok: true; version: number; delivered: "accept_plan" | "wake" }
  | { ok: false; status: 404 | 409; error: string };

export interface ApprovePlanDeps {
  /** Answer a suspended accept_plan (resume its hook). */
  resume: (token: string, payload: { kind: "approval"; approved: true; comment?: string }) => Promise<unknown>;
  /** Wake the conversation with the approval. */
  wake: (conversationId: string, version: number, rowId: string, note?: string) => Promise<unknown>;
}

/**
 * The plan card's Approve. Resolves the open review (refused when it was
 * superseded or already answered — "v4 is current"), then tells the
 * agent: a suspended accept_plan is answered directly (the turn is
 * waiting on it — a wake would duplicate), otherwise a wake (0022).
 */
export async function approvePlan(rowId: string, note: string | undefined, deps: ApprovePlanDeps): Promise<ApprovePlanResult> {
  const row = getPlanRow(db(), rowId);
  if (!row) return { ok: false, status: 404, error: "no such plan review" };
  if (row.resolvedAt !== null) {
    const latest = planState(db(), row.conversationId);
    const current = latest.kind === "review" ? latest.row.card?.version : undefined;
    return {
      ok: false,
      status: 409,
      error: row.answer?.approved
        ? "this plan is already approved"
        : current
          ? `a newer version is current — approve v${current}`
          : "this plan version was replaced",
    };
  }
  if (!approvePlanRow(db(), rowId, note)) return { ok: false, status: 409, error: "this plan was answered already" };
  const version = row.card?.version ?? 0;
  const waiting = pendingAcceptPlanIds(db(), row.conversationId);
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
    return { ok: true, version, delivered: "accept_plan" };
  }
  await deps.wake(row.conversationId, version, rowId, note);
  return { ok: true, version, delivered: "wake" };
}
