import { NextResponse } from "next/server";
import { db } from "@/db";
import { listMessageTexts } from "@/db/chat";
import { getStageRun } from "@/db/machines";
import { rowsToUIMessages } from "@/lib/chat-ui";
import { getHarnessEvents, getHarnessRun, isHarnessKind } from "@/lib/harness-events";

export const dynamic = "force-dynamic";

/**
 * One visit's transcript for the run view's side panel (0012): an agent
 * stage's conversation as UI messages, or a harness stage's event log.
 * Human visits have none (their comment is on the card).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string; seq: string }> },
) {
  const { runId, seq } = await params;
  const visit = /^\d+$/.test(seq) ? getStageRun(db(), runId, Number(seq)) : null;
  if (!visit?.sessionId) return NextResponse.json({ error: "no transcript" }, { status: 404 });
  if (visit.kind === "agent") {
    return NextResponse.json({
      kind: "agent",
      messages: rowsToUIMessages(listMessageTexts(db(), visit.sessionId)),
    });
  }
  if (visit.kind === "harness" && visit.harness && isHarnessKind(visit.harness)) {
    return NextResponse.json({
      kind: "harness",
      run: getHarnessRun(visit.sessionId, visit.harness),
      events: getHarnessEvents(visit.sessionId, visit.harness).events,
    });
  }
  return NextResponse.json({ error: "no transcript" }, { status: 404 });
}
