import { notFound, permanentRedirect } from "next/navigation";
import { HarnessSessionView } from "@/components/harness-session-view";
import {
  getHarnessEvents,
  getHarnessRun,
  isHarnessKind,
} from "@/lib/harness-events";

export const dynamic = "force-dynamic";

/**
 * The harness session view (0005/0006; URL shape re-decided 2026-10-01):
 * /h/<harness>/<eveSessionId> renders that harness's event stream for
 * the conversation — one URL shape for every harness, pi included.
 * Legacy shapes still resolve by permanent redirect, so old links never
 * break: /h/<id> (0005 pi) and /h/<id>/<harness> (0006 order).
 */
export default async function HarnessSessionPage({
  params,
}: {
  params: Promise<{ harness: string; sessionId: string }>;
}) {
  const { harness, sessionId } = await params;

  // Canonical shape: /h/<harness>/<sessionId>.
  if (isHarnessKind(harness)) {
    const run = getHarnessRun(sessionId, harness);
    if (run) {
      const page = getHarnessEvents(sessionId, harness);
      return (
        <HarnessSessionView initialRun={run} initialEvents={page.events} />
      );
    }
  }

  // Legacy two-segment shape (0006): /h/<eveSessionId>/<harness> — the
  // segments arrive here swapped. Redirect to canonical order; the
  // target's run exists (we just looked it up), so this cannot loop.
  if (isHarnessKind(sessionId)) {
    const run = getHarnessRun(harness, sessionId);
    if (run) permanentRedirect(`/h/${sessionId}/${harness}`);
  }

  notFound();
}
