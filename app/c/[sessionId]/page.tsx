import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import type { UIMessage } from "ai";
import { ChatSurface } from "@/components/chat";
import { db } from "@/db";
import { conversations, projects } from "@/db/schema";
import { getActiveRun, listMessageTexts } from "@/db/chat";

/**
 * Open a conversation by its durable address (0010 Phase 4). History
 * rehydrates from the store (messages rows — the conversation's source
 * of truth); a live turn is reattached by passing its run id, which the
 * transport uses to reconnect to the durable stream.
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

  const project = conversation.projectId
    ? db()
        .query.projects.findFirst({
          where: eq(projects.id, conversation.projectId),
        })
        .sync()
    : undefined;

  const initialMessages: UIMessage[] = listMessageTexts(db(), sessionId).map((row) => ({
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    parts: [{ type: "text", text: row.text }],
    metadata: { at: new Date(row.at).toISOString() },
  }));

  return (
    <ChatSurface
      conversationId={sessionId}
      initialMessages={initialMessages}
      activeRunId={getActiveRun(db(), sessionId)}
      projectId={project?.id}
      projectName={project?.name}
      initialModelId={conversation.modelId}
      initialSandboxPref={conversation.sandboxPref}
    />
  );
}
