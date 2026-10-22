import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ChatSurface } from "@/components/chat";
import { db } from "@/db";
import { conversations, projects } from "@/db/schema";
import { getActiveRun, listMessageTextsPage } from "@/db/chat";
import { listProjectHosts } from "@/db/hosts";
import { parseStoredChatRoute } from "@/db/providers";
import { rowsToUIMessages, untilLiveTurn } from "@/lib/chat-ui";

/**
 * Open a conversation by its durable address (0010 Phase 4). History
 * hydrates as the newest TAIL window (0075: `Load earlier messages`
 * pages the rest on demand); a live turn is reattached by passing its
 * run id, which the transport uses to reconnect to the durable stream.
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
  // 0075: hydrate the newest tail window, ALIGNED: walk pages back
  // until the window's OLDEST row is a turn opener (`t_…`, the id
  // recordUserMessage writes) or the conversation's start. A window
  // that opens mid-fold renders a partial first turn — tool-result
  // rows whose calls sit below the seam drop — and the Load-earlier
  // page (aligned by construction) then re-splits the turn into two
  // bubbles. Alignment is independent of a live run: a seam inside the
  // live turn's fold stops at exactly that turn's opener (the row
  // `untilLiveTurn` cuts at, keeping the replayed turn's persisted
  // slices out of the initial render, 0037); a seam in an older turn
  // aligns to its own opener. An exhausted walk (no `t_` at the start)
  // is the pre-0010 prefix — aligned by definition.
  let page = listMessageTextsPage(db(), sessionId, { tail: HYDRATE_TAIL });
  while (page.rows.length > 0 && !page.rows[0].id.startsWith("t_") && page.olderCursor != null) {
    const older = listMessageTextsPage(db(), sessionId, { tail: HYDRATE_TAIL, before: page.olderCursor });
    page = { rows: [...older.rows, ...page.rows], olderCursor: older.olderCursor, olderRemaining: older.olderRemaining };
  }
  const initialMessages = rowsToUIMessages(activeRunId ? untilLiveTurn(page.rows) : page.rows);
  // 0043 amendment: the auto-approve toggle only makes sense where exec
  // itself does — a project with hosts on its allow-list.
  const hasHosts = project ? listProjectHosts(db(), project.id).length > 0 : false;

  return (
    <ChatSurface
      conversationId={sessionId}
      initialMessages={initialMessages}
      activeRunId={activeRunId}
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
