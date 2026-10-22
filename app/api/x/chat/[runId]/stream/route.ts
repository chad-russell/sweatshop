import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";

/**
 * 0010 spike reconnect route (vendored ChatSessionModeling.md pattern):
 * replay the durable raw ModelCallStreamPart stream from index 0 and
 * apply the client's UI cursor, so a reconnected browser neither misses
 * nor duplicates chunks.
 *
 * 0076: this route now serves exactly one caller — a tab RECONNECTING to
 * a run IT started (a dropped connection mid-send). Page loads never
 * attach it anymore (they hydrate persisted slices + poll), so the
 * full-journal replay below only ever covers the few chunks the sending
 * tab itself already showed.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
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
    .getReadable({ startIndex: 0 })
    .pipeThrough(createModelCallToUIChunkTransform({ uiStartIndex: startIndex }));

  return createUIMessageStreamResponse({
    stream,
    headers: { "x-workflow-run-id": runId },
  });
}
