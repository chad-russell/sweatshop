import { NextResponse } from "next/server";
import { loadModeChrome } from "@/lib/chat/mode-chrome";

export const dynamic = "force-dynamic";

/** 0055 PR2: the Mode chip's data for a conversation — null body for a
 *  plain chat (never a 404; "no mode" is a normal state, not an error). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;
  return NextResponse.json(await loadModeChrome(conversationId));
}
