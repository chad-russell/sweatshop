import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";

/**
 * 0077: the resume route for a run this tab did NOT start — a reload,
 * wake, or steered send that discovered a live turn. `cursor` (the path
 * segment) is `conversations.active_stream_cursor`: the raw journal
 * index of the turn's current slice boundary, recorded by `persistTurn`.
 * Reading the durable stream FROM that cursor (rather than index 0, the
 * `[runId]/stream` route's replay) skips every earlier slice — no
 * multi-second journal replay, no duplicated history. `startIndex` (the
 * query param) is the UI chunk offset `WorkflowChatTransport` appends on
 * its own reconnect retries, same contract as the index-0 route.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string; cursor: string }> },
) {
  const { runId, cursor: cursorRaw } = await params;
  const cursor = Number(cursorRaw);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    return Response.json({ error: "cursor must be a non-negative safe integer" }, { status: 400 });
  }
  const startIndex = Number(new URL(request.url).searchParams.get("startIndex") ?? "0");
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
    return Response.json(
      { error: "startIndex must be a non-negative safe integer" },
      { status: 400 },
    );
  }

  const run = getRun(runId);
  if (!(await run.exists)) {
    return Response.json({ error: "unknown run" }, { status: 404 });
  }

  const stream = run
    .getReadable({ startIndex: cursor })
    .pipeThrough(createModelCallToUIChunkTransform({ uiStartIndex: startIndex }));

  return createUIMessageStreamResponse({
    stream,
    headers: { "x-workflow-run-id": runId },
  });
}
