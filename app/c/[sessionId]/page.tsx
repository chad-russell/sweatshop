import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ChatSurface } from "@/components/chat";
import { db } from "@/db";
import { conversations } from "@/db/schema";

/**
 * Open a conversation by its durable address. The id must exist in the
 * sweatshop store (it was mirrored by the stream hook); the client then
 * replays the session from eve's authoritative stream (streamIndex 0).
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

  return <ChatSurface sessionId={sessionId} />;
}
