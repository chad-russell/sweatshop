import { notFound, permanentRedirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { ChatSurface } from "@/components/chat";
import { db } from "@/db";
import { conversations, projects } from "@/db/schema";
import { getActiveRun, listMessageTexts } from "@/db/chat";
import { parseStoredChatRoute } from "@/db/providers";
import { rowsToUIMessages, untilLiveTurn } from "@/lib/chat-ui";

/**
 * Open a conversation by its durable address (0010 Phase 4). History
 * rehydrates from the store (messages rows — the conversation's source
 * of truth); a live turn is reattached by passing its run id, which the
 * transport uses to reconnect to the durable stream. Run conversations
 * (0012) redirect to /r; stage conversations still open here.
 */
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
  // 0012: a run conversation's address is its run view.
  if (conversation.kind === "run") permanentRedirect(`/r/${sessionId}`);

  const project = conversation.projectId
    ? db()
        .query.projects.findFirst({
          where: eq(projects.id, conversation.projectId),
        })
        .sync()
    : undefined;

  // A live turn persists slice by slice (0037), but a reload REPLAYS the
  // turn's whole stream from index 0 — so the hydrated transcript stops
  // at the live turn's user message, or its slices would render twice.
  const activeRunId = getActiveRun(db(), sessionId);
  const rows = listMessageTexts(db(), sessionId);
  const initialMessages = rowsToUIMessages(activeRunId ? untilLiveTurn(rows) : rows);

  return (
    <ChatSurface
      conversationId={sessionId}
      initialMessages={initialMessages}
      activeRunId={activeRunId}
      projectId={project?.id}
      projectName={project?.name}
      conversationTitle={conversation.title}
      initialRoute={parseStoredChatRoute(conversation.route)}
    />
  );
}
