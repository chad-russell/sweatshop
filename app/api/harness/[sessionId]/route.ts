import { getHarnessEvents } from "@/lib/harness-events";

export const dynamic = "force-dynamic";

/**
 * Harness visibility (0005): the full structured event log for one
 * conversation's pi session — every model step, tool call, input, and
 * output as it happened. Attach point for richer UI (SSE) later.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const events = getHarnessEvents(sessionId);
  return Response.json({ sessionId, count: events.length, events });
}
