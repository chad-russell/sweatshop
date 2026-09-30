import { notFound } from "next/navigation";
import { HarnessSessionView } from "@/components/harness-session-view";
import { getHarnessEvents, getHarnessRun } from "@/lib/harness-events";

export const dynamic = "force-dynamic";

/**
 * The harness session view (0005): /h/<eveSessionId> renders the pi
 * session's event stream conversation-style. Separate from /c (eve
 * transcript) by design — different source, same visual family.
 * Non-pi harnesses live one level down (0006): /h/<id>/<harness>.
 */
export default async function HarnessPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const run = getHarnessRun(sessionId, "pi");
  if (!run) notFound();
  const page = getHarnessEvents(sessionId, "pi");

  return (
    <HarnessSessionView initialRun={run} initialEvents={page.events} />
  );
}
