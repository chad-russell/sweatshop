import { db } from "@/db";
import { getPendingInputCard, listPendingInputs, resolvePendingInput } from "@/db/chat";
import { chatApprovalHook } from "@/workflows/chat/hooks";
import { isAskOwnerCard, mapTypedTextToAnswers } from "@/lib/question-form";

/**
 * 0037 (Chad's decision): typing in a thread while it waits on him is a
 * revise. The oldest pending input of the conversation is answered with
 * the text — an approval as DENIED with the text as the comment (the
 * agent reads "Chad declined …: <text>" and keeps going in the same
 * context), a question as the answer. Approve stays an explicit button.
 *
 * 0041/0064: plan and outline reviews are skipped — they never block the
 * turn, so a message while one is open is just a message (the model
 * decides what it is about). Approval is the explicit button or
 * accept_outline.
 *
 * Returns what was answered, or null when nothing was pending (the
 * caller then queues a steer as before). A pending whose run already
 * went terminal (resume: "Hook not found" — the card outlived its
 * hook, 2026-10-13) is resolved as orphaned and SKIPPED, so a dead
 * card never shadows the live one; anything left unanswered is null —
 * never a lost message.
 */
export interface PendingAnswer {
  toolCallId: string;
  kind: "approval" | "question";
}

export interface AnswerDeps {
  resume?: (token: string, payload: Parameters<typeof chatApprovalHook.resume>[1]) => Promise<unknown>;
}

/**
 * The resume can never succeed again: the run that suspended on the
 * hook went terminal (cancelled, failed, expired). The workflow SDK
 * does not export the error classes, so match the message (the exact
 * strings of HookNotFoundError / RunExpiredError).
 */
export function isHookGoneError(err: unknown): boolean {
  return err instanceof Error && /hook not found|run expired/i.test(err.message);
}

export async function answerPendingWithText(
  conversationId: string,
  text: string,
  deps: AnswerDeps = {},
): Promise<PendingAnswer | null> {
  // 0041/0064: a plan or outline review is not a suspension — typing is
  // discussion (an ordinary message), never an answer to it.
  const pendings = listPendingInputs(db(), conversationId).filter((p) => p.kind !== "plan" && p.kind !== "outline");
  const resume = deps.resume ?? ((token, p) => chatApprovalHook.resume(token, p));
  for (const pending of pendings) {
    const kind = pending.kind === "question" ? "question" : "approval";
    // 0081: a structured ask_owner card maps the typed text onto its
    // spec (option number/letter/label, "you pick", or Other) instead of
    // the legacy bare `answer` string.
    const card = kind === "question" ? getPendingInputCard(db(), pending.id) : null;
    const structuredAnswers = isAskOwnerCard(card) ? mapTypedTextToAnswers(card, text) : null;
    const payload =
      kind === "question"
        ? structuredAnswers
          ? { kind: "question" as const, answers: structuredAnswers }
          : { kind: "question" as const, answer: text }
        : { kind: "approval" as const, approved: false, comment: text };
    try {
      await resume(pending.id, payload);
    } catch (err) {
      if (!isHookGoneError(err)) return null; // transient — a later send retries
      resolvePendingInput(db(), pending.id, { ...payload, orphaned: "hook-gone" });
      continue; // the dead card resolved; the text belongs to the next pending
    }
    resolvePendingInput(db(), pending.id, payload);
    return { toolCallId: pending.id, kind };
  }
  return null;
}
