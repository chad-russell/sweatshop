/**
 * 0012: where a conversation opens. A run conversation's id IS its run
 * id, so it opens the run view; everything else opens the chat.
 */
export type ConversationKind = "chat" | "run" | "stage";

export function conversationHref(item: { id: string; kind?: string | null }): string {
  return item.kind === "run" ? `/r/${item.id}` : `/c/${item.id}`;
}
