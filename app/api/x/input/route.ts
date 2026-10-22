import { NextResponse } from "next/server";
import { db } from "@/db";
import { ownerName } from "@/lib/agent/owner";
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
    approveOutline?: boolean;
    conversationId?: string;
    editOutline?: unknown;
    baseVersion?: number;
    approve?: boolean;
    note?: string;
  };
  if (body.editOutline !== undefined) {
    if (!body.conversationId) {
      return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
    }
    const [{ editOutline }, { wakeConversation }] = await Promise.all([
      import("@/lib/chat/outline-edit"),
      import("@/lib/chat/wake"),
    ]);
    const result = await editOutline(
      {
        conversationId: body.conversationId,
        outline: body.editOutline,
        baseVersion: body.baseVersion,
        approve: body.approve,
        note: body.note?.trim() || undefined,
      },
      {
        wake: (conversationId, version, id, approved, note) =>
          wakeConversation(conversationId, {
            kind: "outline",
            id,
            name: `outline v${version}`,
            status: approved ? "approved" : "edited",
            detail: approved
              ? `${ownerName()} edited and approved outline v${version}${note ? `: ${note}` : ""}.`
              : `${ownerName()} edited outline v${version}.`,
            url: `/c/${conversationId}`,
          }),
      },
    );
    return result.ok
      ? NextResponse.json(result)
      : NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }
  if (!body.toolCallId) {
    return NextResponse.json({ error: "toolCallId is required" }, { status: 400 });
  }
  // 0064: same mechanism for the outline card's Approve.
  if (body.approveOutline === true) {
    const result = await approveOutlineFromCard(body.toolCallId, body.note?.trim() || undefined);
    return result.ok
      ? NextResponse.json({ approved: true, version: result.version, delivered: result.delivered })
      : NextResponse.json({ error: result.error }, { status: result.status });
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
    // The run that suspended on this hook already went terminal
    // (cancelled/failed/expired): there is nothing to resume, and the
    // card must not outlive its hook (2026-10-13 inbox bug — Deny
    // 409'd forever). Resolve the row and answer OK so the card
    // clears; anything else (transient) stays a 409.
    const { isHookGoneError } = await import("@/lib/chat/answer-pending");
    if (isHookGoneError(err)) {
      const { resolvePendingInput } = await import("@/db/chat");
      resolvePendingInput(db(), body.toolCallId, { ...payload, orphaned: "hook-gone" });
      return NextResponse.json({ resumed: false, cleared: true });
    }
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

async function approveOutlineFromCard(rowId: string, note: string | undefined) {
  const [{ approveOutline }, { wakeConversation }] = await Promise.all([
    import("@/lib/agent/tools/outline"),
    import("@/lib/chat/wake"),
  ]);
  return approveOutline(rowId, note, {
    resume: (token, payload) => chatApprovalHook.resume(token, payload),
    wake: (conversationId, version, id, n) =>
      wakeConversation(conversationId, {
        kind: "outline",
        id,
        name: `outline v${version}`,
        status: "approved",
        detail: `${ownerName()} approved outline v${version}${n ? `: ${n}` : ""}.`,
        url: `/c/${conversationId}`,
      }),
  });
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
