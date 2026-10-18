/**
 * 0046: where a conversation opens. A synthetic harness row (kind
 * "harness") opens the harness view scoped to that one call —
 * /h/<harness>/<owning conversation id>/<call id>. The session URL
 * alone was shared by every call of a harness, so their rows all
 * highlighted together. Everything else opens the plain chat.
 */
export type ConversationKind = "chat" | "stage";

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
    return `/h/${item.harness}/${item.parentConversationId ?? item.id}/${item.id}`;
  }
  return `/c/${item.id}`;
}
