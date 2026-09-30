import { notFound } from "next/navigation";
import { HarnessSessionView } from "@/components/harness-session-view";
import { getHarnessEvents, getHarnessRun } from "@/lib/harness-events";

export const dynamic = "force-dynamic";

/**
 * The harness session view (0005): /h/<eveSessionId> renders the pi
 * session's event stream conversation-style. Separate from /c (eve
 * transcript) by design — different source, same visual family.
 */
export default async function HarnessPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const run = getHarnessRun(sessionId);
  if (!run) notFound();
  const events = getHarnessEvents(sessionId);

  return <HarnessSessionView initialRun={run} initialEvents={events} />;
}
