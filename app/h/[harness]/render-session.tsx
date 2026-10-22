import { eq } from "drizzle-orm";
import { HarnessSessionView } from "@/components/harness-session-view";
import { db } from "@/db";
import { getRunningHarnessCall } from "@/db/harness-calls";
import { sandboxForHarnessSession } from "@/db/sandbox-view";
import { conversations, projects, type HarnessCall } from "@/db/schema";
import { HARNESS_PAGE } from "@/lib/harness-paging";
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
  const page = getHarnessEvents(
    sessionId,
    harness,
    // The newest page (still oldest-first) so the view opens at the
    // bottom; older pages come from Load earlier, newer from the poll.
    {
      tail: true,
      limit: HARNESS_PAGE,
      ...(call ? { fromAt: call.createdAt, toAt: call.settledAt ?? undefined } : {}),
    },
  );
  // The parent conversation anchors the breadcrumb (the session id IS
  // the conversation id); it may be gone, so everything degrades.
  const parent = db()
    .query.conversations.findFirst({ where: eq(conversations.id, sessionId) })
    .sync();
  const project = parent?.projectId
    ? db().query.projects.findFirst({ where: eq(projects.id, parent.projectId) }).sync()
    : undefined;
  // 0063: the call to cancel — the per-call page's own call, else (the
  // session page) the session's newest still-running call of this kind —
  // a SQL status filter, not a client-side filter of the 50 newest calls
  // of any kind (a long-running call can sit behind more than that).
  const callId = call?.id ?? getRunningHarnessCall(db(), sessionId, harness)?.id;
  return (
    <HarnessSessionView
      initialRun={run}
      initialEvents={page.events}
      initialHasOlder={page.hasOlder ?? false}
      sandbox={sandboxForHarnessSession(db(), sessionId)}
      callId={callId}
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
