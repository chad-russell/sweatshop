import { notFound } from "next/navigation";
import { HarnessSessionView } from "@/components/harness-session-view";
import {
  getHarnessEvents,
  getHarnessRun,
  isHarnessKind,
} from "@/lib/harness-events";

export const dynamic = "force-dynamic";

/**
 * Harness session view for non-pi harnesses (0006):
 * /h/<eveSessionId>/<harness> — same rendering family as /h/<id> (pi),
 * distinct URL so links can never alias across harnesses.
 */
export default async function HarnessKindPage({
  params,
}: {
  params: Promise<{ sessionId: string; harness: string }>;
}) {
  const { sessionId, harness } = await params;
  if (harness === "pi" || !isHarnessKind(harness)) notFound();
  const run = getHarnessRun(sessionId, harness);
  if (!run) notFound();
  const page = getHarnessEvents(sessionId, harness);

  return (
    <HarnessSessionView initialRun={run} initialEvents={page.events} />
  );
}
