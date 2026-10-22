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
 * incrementally with ?after=<lastEventId>). ?from=/&to= (Unix ms,
 * inclusive) scope it to one call's window (0046 per-call view).
 * ?before=<id> pages the window's older events (0075 load-earlier);
 * ?tail=<n> returns the newest n events instead of the oldest.
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
  const num = (key: string): number | undefined => {
    const raw = url.searchParams.get(key);
    return raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
  };
  const afterId = num("after");
  const beforeId = num("before");
  const tail = num("tail");
  const window = { fromAt: num("from"), toAt: num("to") };

  const run = getHarnessRun(sessionId, harness);
  const page =
    tail !== undefined && afterId === undefined && beforeId === undefined
      ? getHarnessEvents(sessionId, harness, { limit: tail, tail: true, ...window })
      : getHarnessEvents(sessionId, harness, { afterId, beforeId, ...window });
  return Response.json({
    sessionId,
    harness,
    run,
    count: page.events.length,
    cursor: page.cursor,
    remaining: page.remaining,
    events: page.events,
  });
}
