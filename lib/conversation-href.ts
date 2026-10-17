/**
 * 0012: where a conversation opens. A run conversation's id IS its run
 * id, so it opens the run view; everything else opens the chat.
 * 0046: a synthetic harness row (kind "harness") opens the harness
 * session view — /h/<harness>/<owning conversation id> (the call's
 * conversationId is its harness session id, 0010).
 */
export type ConversationKind = "chat" | "run" | "stage";

export function conversationHref(item: {
  id: string;
  kind?: string | null;
  /** 0046: the harness name for kind "harness" rows. */
  harness?: string | null;
  /** 0046: the owning conversation for kind "harness" rows. */
  parentConversationId?: string | null;
}): string {
  // A harness row without its harness name can't build a /h/ URL —
  // fall through to the ordinary mapping (unreachable from loadSidebar,
  // but this is a pure exported function).
  if (item.kind === "harness" && item.harness) {
    return `/h/${item.harness}/${item.parentConversationId ?? item.id}`;
  }
  return item.kind === "run" ? `/r/${item.id}` : `/c/${item.id}`;
}
