import { notFound } from "next/navigation";
import { db } from "@/db";
import { getHarnessCall } from "@/db/harness-calls";
import { getHarnessRun, isHarnessKind } from "@/lib/harness-events";
import { renderHarnessSession } from "../../render-session";

export const dynamic = "force-dynamic";

/**
 * 0046: one harness call — /h/<harness>/<sessionId>/<callId>. Each call
 * has its own URL so sidebar rows select individually (the session URL
 * was shared by every call of a harness). The call must belong to this
 * session and harness; its events are scoped to the call's time window.
 */
export default async function HarnessCallPage({
  params,
}: {
  params: Promise<{ harness: string; sessionId: string; callId: string }>;
}) {
  const { harness, sessionId, callId } = await params;
  if (!isHarnessKind(harness)) notFound();
  const call = getHarnessCall(db(), callId);
  if (!call || call.conversationId !== sessionId || call.kind !== harness) notFound();
  const run = getHarnessRun(sessionId, harness);
  if (!run) notFound();
  return renderHarnessSession(sessionId, harness, run, call);
}
