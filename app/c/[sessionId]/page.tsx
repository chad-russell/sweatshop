import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ChatSurface } from "@/components/chat";
import { db } from "@/db";
import { conversations, projects } from "@/db/schema";
import { getActiveRun, getActiveStreamCursor, listMessageTextsPage } from "@/db/chat";
import { listProjectHosts } from "@/db/hosts";
import { parseStoredChatRoute } from "@/db/providers";
import { rowsToUIMessages } from "@/lib/chat-ui";

/**
 * Open a conversation by its durable address (0010 Phase 4). History
 * hydrates as the newest TAIL window (0075: `Load earlier messages`
 * pages the rest on demand), including every slice a live turn has
 * persisted so far; a live turn is reattached by passing its run id and
 * resume cursor, which the session uses to resume the AI SDK's own
 * durable stream from exactly the in-progress slice (0077) — never a
 * from-chunk-0 replay.
 */
/** 0075: rows in the initial tail window (a typical screenful of turns). */
const HYDRATE_TAIL = 150;

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const conversation = db()
    .query.conversations.findFirst({
      where: eq(conversations.id, sessionId),
    })
    .sync();

  if (!conversation) notFound();

  const project = conversation.projectId
    ? db()
        .query.projects.findFirst({
          where: eq(projects.id, conversation.projectId),
        })
        .sync()
    : undefined;

  const activeRunId = getActiveRun(db(), sessionId);
  // 0077: the live run's resume cursor — where `/api/x/chat/<runId>/
  // from/<cursor>/stream` starts reading the durable journal. Every
  // slice up to it is already in the hydrated rows below; resuming from
  // here picks up exactly the in-progress slice, with nothing repeated.
  const activeStreamCursor = activeRunId ? getActiveStreamCursor(db(), sessionId) : null;
  // 0075: hydrate the newest tail window, aligned to a turn opener (a
  // live turn's already-persisted slices included — the resume above
  // supplies only what comes after them).
  let page = listMessageTextsPage(db(), sessionId, { tail: HYDRATE_TAIL });
  while (!page.rows.some((row) => row.id.startsWith("t_")) && page.olderCursor != null) {
    const older = listMessageTextsPage(db(), sessionId, { tail: HYDRATE_TAIL, before: page.olderCursor });
    page = { rows: [...older.rows, ...page.rows], olderCursor: older.olderCursor, olderRemaining: older.olderRemaining };
  }
  const initialMessages = rowsToUIMessages(page.rows);
  // 0043 amendment: the auto-approve toggle only makes sense where exec
  // itself does — a project with hosts on its allow-list.
  const hasHosts = project ? listProjectHosts(db(), project.id).length > 0 : false;

  return (
    <ChatSurface
      conversationId={sessionId}
      initialMessages={initialMessages}
      activeRunId={activeRunId}
      activeStreamCursor={activeStreamCursor}
      projectId={project?.id}
      projectName={project?.name}
      conversationTitle={conversation.title}
      initialRoute={parseStoredChatRoute(conversation.route)}
      hasHosts={hasHosts}
      initialHostAutoApprove={!!conversation.hostAutoApprove}
      olderCursor={page.olderCursor}
      olderRemaining={page.olderRemaining}
    />
  );
}
