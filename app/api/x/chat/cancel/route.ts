import { NextResponse } from "next/server";
import { getRun } from "workflow/api";
import { db } from "@/db";
import { clearActiveRunIfMatches, getActiveRun, resolveOrphanedPendingInputs } from "@/db/chat";

export const dynamic = "force-dynamic";

/**
 * 0010 spike cancel: cancel the conversation's live turn run (if any).
 * Conversation-keyed (not run-keyed) because the page never learns the
 * runId — the transport owns it.
 *
 * Cancelling kills the run's hooks too, so the conversation's pending
 * cards are resolved here (2026-10-13: a cancelled run left approval
 * cards whose Deny could only ever 409).
 */
export async function POST(request: Request) {
  const { conversationId } = (await request.json()) as { conversationId?: string };
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }

  const active = getActiveRun(db(), conversationId);
  if (!active) {
    // No live run: any pending card is already an orphan of a dead one.
    const cleared = resolveOrphanedPendingInputs(db(), conversationId, "cancelled");
    return NextResponse.json({ cancelled: false, clearedPending: cleared.length });
  }

  const run = getRun(active);
  if (!(await run.exists)) {
    clearActiveRunIfMatches(db(), conversationId, active);
    const cleared = resolveOrphanedPendingInputs(db(), conversationId, "cancelled");
    return NextResponse.json({ cancelled: false, clearedPending: cleared.length });
  }
  await run.cancel({ cancelReason: "user stop" });
  clearActiveRunIfMatches(db(), conversationId, active);
  const cleared = resolveOrphanedPendingInputs(db(), conversationId, "cancelled");
  return NextResponse.json({ cancelled: true, runId: active, clearedPending: cleared.length });
}
