import { db } from "@/db";
import { listPendingInputs, resolvePendingInput } from "@/db/chat";
import { chatApprovalHook } from "@/workflows/chat/hooks";

/**
 * 0037 (Chad's decision): typing in a thread while it waits on him is a
 * revise. The oldest pending input of the conversation is answered with
 * the text — an approval as DENIED with the text as the comment (the
 * agent reads "Chad declined …: <text>" and keeps going in the same
 * context), a question as the answer. Approve stays an explicit button.
 *
 * Returns what was answered, or null when nothing was pending (the
 * caller then queues a steer as before). A hook that will not resume
 * (already answered elsewhere) is also null — never a lost message.
 */
export interface PendingAnswer {
  toolCallId: string;
  kind: "approval" | "question";
}

export interface AnswerDeps {
  resume?: (token: string, payload: Parameters<typeof chatApprovalHook.resume>[1]) => Promise<unknown>;
}

export async function answerPendingWithText(
  conversationId: string,
  text: string,
  deps: AnswerDeps = {},
): Promise<PendingAnswer | null> {
  const pending = listPendingInputs(db(), conversationId)[0];
  if (!pending) return null;
  const kind = pending.kind === "question" ? "question" : "approval";
  const payload =
    kind === "question"
      ? { kind: "question" as const, answer: text }
      : { kind: "approval" as const, approved: false, comment: text };
  const resume = deps.resume ?? ((token, p) => chatApprovalHook.resume(token, p));
  try {
    await resume(pending.id, payload);
  } catch {
    return null;
  }
  resolvePendingInput(db(), pending.id, payload);
  return { toolCallId: pending.id, kind };
}
