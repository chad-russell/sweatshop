import { eq } from "drizzle-orm";
import { HarnessSessionView } from "@/components/harness-session-view";
import { db } from "@/db";
import { sandboxForHarnessSession } from "@/db/sandbox-view";
import { conversations, projects, type HarnessCall } from "@/db/schema";
import { getHarnessEvents, type HarnessKind, type HarnessRun } from "@/lib/harness-events";

/**
 * Shared by the session page (/h/<harness>/<sessionId>) and the per-call
 * page (0046: /h/<harness>/<sessionId>/<callId>). With a call, events are
 * scoped to its window: created ≤ at ≤ settled (inclusive; open while it
 * runs).
 */
export function renderHarnessSession(
  sessionId: string,
  harness: HarnessKind,
  run: HarnessRun,
  call?: HarnessCall,
) {
  // 0075: hydrate from the END — the newest 500 events, windowed to the
  // call on a per-call page — with a cursor for older pages on demand.
  const page = getHarnessEvents(
    sessionId,
    harness,
    call
      ? { fromAt: call.createdAt, toAt: call.settledAt ?? undefined, tail: true }
      : { tail: true },
  );
  // The parent conversation anchors the breadcrumb (the session id IS
  // the conversation id); it may be gone, so everything degrades.
  const parent = db()
    .query.conversations.findFirst({ where: eq(conversations.id, sessionId) })
    .sync();
  const project = parent?.projectId
    ? db().query.projects.findFirst({ where: eq(projects.id, parent.projectId) }).sync()
    : undefined;
  return (
    <HarnessSessionView
      initialRun={run}
      initialEvents={page.events}
      initialOlderCursor={page.cursor}
      initialRemaining={page.remaining}
      sandbox={sandboxForHarnessSession(db(), sessionId)}
      call={
        call
          ? {
              id: call.id,
              task: call.task,
              status: call.status,
              createdAt: call.createdAt,
              settledAt: call.settledAt,
            }
          : undefined
      }
      parent={{
        id: sessionId,
        title: parent?.title ?? null,
        exists: !!parent,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
      }}
    />
  );
}
