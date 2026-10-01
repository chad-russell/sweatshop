import { NextResponse } from "next/server";
import { getRun } from "workflow/api";
import { db } from "@/db";
import { clearActiveRunIfMatches, getActiveRun } from "@/db/chat";

export const dynamic = "force-dynamic";

/**
 * 0010 spike cancel: cancel the conversation's live turn run (if any).
 * Conversation-keyed (not run-keyed) because the page never learns the
 * runId — the transport owns it.
 */
export async function POST(request: Request) {
  const { conversationId } = (await request.json()) as { conversationId?: string };
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }
  const active = getActiveRun(db(), conversationId);
  if (!active) return NextResponse.json({ cancelled: false });

  const run = getRun(active);
  if (!(await run.exists)) {
    clearActiveRunIfMatches(db(), conversationId, active);
    return NextResponse.json({ cancelled: false });
  }
  await run.cancel({ cancelReason: "user stop" });
  clearActiveRunIfMatches(db(), conversationId, active);
  return NextResponse.json({ cancelled: true, runId: active });
}
