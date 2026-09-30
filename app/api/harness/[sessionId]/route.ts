import { getHarnessEvents, getHarnessRun } from "@/lib/harness-events";

export const dynamic = "force-dynamic";

/**
 * Harness visibility (0005): run status + the full structured event log
 * for one conversation's harness session — every model step, tool call,
 * input, and output as it happened (events land live; poll).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const run = getHarnessRun(sessionId);
  const events = getHarnessEvents(sessionId);
  return Response.json({ sessionId, run, count: events.length, events });
}
