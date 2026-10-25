/**
 * /api/x/chat minus the transcript paging (0075's lib/chat-fetch.ts
 * stays that endpoint family's paged reader) and the composer's
 * attachment upload: the panel's best-effort title read, the composer's
 * steer send, and turn cancel. None of this is the useChat transport —
 * those streams keep their own machinery.
 */

import { apiFetch, jsonInit } from "./core";

/** The header title of a just-adopted conversation. Any failure (even
 * a network error) is null — the panel simply keeps its old title. */
export async function fetchChatTitle(conversationId: string): Promise<{ title: string | null } | null> {
  try {
    const res = await fetch(`/api/x/chat?conversationId=${encodeURIComponent(conversationId)}`, {
      cache: "no-store",
    });
    return res.ok ? ((await res.json()) as { title: string | null }) : null;
  } catch {
    return null;
  }
}

/**
 * Queue a steer on a live turn (drained between the turn's slices).
 * Fire-and-forget by design: the message shows as sent locally; a
 * rejected request stays the caller's unhandled promise, as it was
 * when the composer called fetch directly.
 */
export async function steerChat(conversationId: string, text: string): Promise<void> {
  await apiFetch("/api/x/chat", jsonInit("POST", { conversationId, text }));
}

/** 0010: stop the conversation's live run. Best-effort — the local
 * chat.stop() already happened; a failing cancel is dropped. */
export async function cancelChat(conversationId: string): Promise<void> {
  await apiFetch("/api/x/chat/cancel", jsonInit("POST", { conversationId })).catch(() => undefined);
}

/** Uploaded file part. `error` is the endpoint's message or the status
 * fallback — the composer rethrows it as its notice. Network errors
 * reject (the upload flow's own catch reports them). */
export async function uploadAttachment(
  form: FormData,
): Promise<{ url: string; mediaType: string } | { error: string }> {
  const res = await apiFetch<{ error?: string; url?: string; mediaType?: string }>(
    "/api/x/attachments",
    { method: "POST", body: form },
  );
  if (res.ok && res.body?.url && res.body.mediaType) {
    return { url: res.body.url, mediaType: res.body.mediaType };
  }
  return { error: (res.body as { error?: string } | null)?.error ?? `upload failed (${res.status})` };
}
