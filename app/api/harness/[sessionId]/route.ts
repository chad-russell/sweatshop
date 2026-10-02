import {
  getHarnessEvents,
  getHarnessRun,
  isHarnessKind,
} from "@/lib/harness-events";

export const dynamic = "force-dynamic";

/**
 * Harness visibility (0005/0006): run status + the structured event log
 * for one conversation's harness session — every model step, tool call,
 * input, and output as it happened (events land live; poll
 * incrementally with ?after=<lastEventId>).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const url = new URL(request.url);
  const harness = url.searchParams.get("harness") ?? "pi";
  if (!isHarnessKind(harness)) {
    return Response.json({ error: "unknown harness" }, { status: 400 });
  }
  const afterRaw = url.searchParams.get("after");
  const afterId =
    afterRaw !== null && /^\d+$/.test(afterRaw) ? Number(afterRaw) : undefined;

  // ?tail=<n>: the newest n events (live activity peeks), not the oldest.
  const tailRaw = url.searchParams.get("tail");
  const tail = tailRaw !== null && /^\d+$/.test(tailRaw) ? Number(tailRaw) : undefined;

  const run = getHarnessRun(sessionId, harness);
  const page =
    tail !== undefined && afterId === undefined
      ? getHarnessEvents(sessionId, harness, { limit: tail, tail: true })
      : getHarnessEvents(sessionId, harness, { afterId });
  return Response.json({
    sessionId,
    harness,
    run,
    count: page.events.length,
    cursor: page.cursor,
    events: page.events,
  });
}
