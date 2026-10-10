import { NextResponse } from "next/server";
import { db } from "@/db";
import { chatApprovalHook } from "@/workflows/chat/hooks";

export const dynamic = "force-dynamic";

/**
 * 0010 human input: answer a pending approval/question hook. The
 * toolCallId doubles as the hook token (vendored HumanInTheLoop.md);
 * the inbox cards and the inline chat card both POST here. An approval
 * sends {approved, comment?}; a question sends {answer}.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    toolCallId?: string;
    approved?: boolean;
    comment?: string;
    answer?: string;
  };
  if (!body.toolCallId) {
    return NextResponse.json({ error: "toolCallId is required" }, { status: 400 });
  }
  const isApproval = typeof body.approved === "boolean";
  const isQuestion = typeof body.answer === "string" && body.answer.trim().length > 0;
  if (!isApproval && !isQuestion) {
    return NextResponse.json(
      { error: "either approved (boolean) or answer (non-empty string) is required" },
      { status: 400 },
    );
  }

  const payload = isApproval
    ? {
        kind: "approval" as const,
        approved: body.approved,
        ...(body.comment ? { comment: body.comment } : {}),
      }
    : { kind: "question" as const, answer: body.answer!.trim() };

  try {
    await chatApprovalHook.resume(body.toolCallId, payload);
  } catch (err) {
    return NextResponse.json(
      { error: `could not resume: ${err instanceof Error ? err.message : String(err)}` },
      { status: 409 },
    );
  }
  // The inbox's pending row is answered (the hook was the suspension;
  // this row is its observable record).
  const { resolvePendingInput } = await import("@/db/chat");
  resolvePendingInput(db(), body.toolCallId, payload);
  return NextResponse.json({ resumed: true });
}

/** 0037: the runtime-built evidence for one pending input's card (the
 *  transcript's create_pr card reads it while the approval waits). */
export async function GET(request: Request) {
  const toolCallId = new URL(request.url).searchParams.get("toolCallId");
  if (!toolCallId) {
    return NextResponse.json({ error: "toolCallId is required" }, { status: 400 });
  }
  const { getPendingInputCard } = await import("@/db/chat");
  return NextResponse.json({ evidence: getPendingInputCard(db(), toolCallId) });
}
