import { NextResponse } from "next/server";
import { chatApprovalHook } from "@/workflows/chat/hooks";

export const dynamic = "force-dynamic";

/**
 * 0010 spike human input: answer a pending approval/question hook. The
 * toolCallId doubles as the hook token (vendored HumanInTheLoop.md);
 * the inbox cards (Phase 4) and the /x page both POST here.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    toolCallId?: string;
    approved?: boolean;
    comment?: string;
  };
  if (!body.toolCallId || typeof body.approved !== "boolean") {
    return NextResponse.json(
      { error: "toolCallId and approved are required" },
      { status: 400 },
    );
  }
  try {
    await chatApprovalHook.resume(body.toolCallId, {
      approved: body.approved,
      ...(body.comment ? { comment: body.comment } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `could not resume: ${err instanceof Error ? err.message : String(err)}` },
      { status: 409 },
    );
  }
  return NextResponse.json({ resumed: true });
}
