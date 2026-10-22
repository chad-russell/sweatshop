import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ChatSurface } from "@/components/chat";
import { db } from "@/db";
import { conversations, projects } from "@/db/schema";
import { getActiveRun, listMessageTextsPage } from "@/db/chat";
import { listProjectHosts } from "@/db/hosts";
import { parseStoredChatRoute } from "@/db/providers";
import { rowsToUIMessages } from "@/lib/chat-ui";

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
  // 0075: hydrate the newest tail window, aligned to a turn opener.
  // 0076: a LIVE turn hydrates from its persisted slices too — no stream
  // attach, no replay. The durable journal cannot resume mid-stream
  // cheaply (the local world scans its chunk files from index 0), so a
  // reload used to replay the whole turn at ~500 chunks/s — the "watch
  // the world replay" load. Instead the session mounts ready, shows the
  // spinner (activeRunId is display-only now), and the wake poll
  // appends each newly persisted slice within ~2s. The tab that STARTED
  // the turn keeps its token stream; only reloaded tabs view by slices.
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
