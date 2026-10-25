"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 0015: a session that started fresh is adopted the moment its first
 * send creates the conversation server-side. From then on it behaves
 * adopted (mark-seen, harness links, frame state) WITHOUT remounting
 * or changing its chat id — the client-generated id IS the server id,
 * and killing the useChat instance mid-turn would drop the stream
 * (the transport's reconnect only works while the instance lives).
 *
 * Two things happen once, each reported to the frame at most once:
 * `onAdopted` the moment the first message lands (the frame rewrites
 * the URL / refreshes the sidebar), and `onAddressable` once that
 * creating turn has SETTLED — only then may the frame give the session
 * its durable address. A frame whose address is a different route (the
 * page frame's / → /c/<id>) remounts on the next router.refresh(); mid-
 * turn that drops the live stream and mounts a snapshot taken before
 * the turn wrote anything — the blank "new chat" Chad saw after a
 * first send (2026-10-07).
 */
export function useAdoption({
  adopted,
  conversationId,
  messagesLength,
  isBusy,
  onAdopted,
  onAddressable,
}: {
  adopted: boolean;
  conversationId: string;
  messagesLength: number;
  isBusy: boolean;
  onAdopted?: (conversationId: string) => void;
  onAddressable?: (conversationId: string) => void;
}) {
  const [selfAdopted, setSelfAdopted] = useState(false);
  const adoptedNow = adopted || selfAdopted;

  // A send that created the conversation reports to the frame exactly
  // once (the page frame rewrites the URL and refreshes the sidebar).
  const adoptedRef = useRef(false);
  const onAdoptedRef = useRef(onAdopted);
  useEffect(() => {
    onAdoptedRef.current = onAdopted;
  }, [onAdopted]);
  useEffect(() => {
    if (adopted || messagesLength === 0) return;
    if (adoptedRef.current) return;
    adoptedRef.current = true;
    setSelfAdopted(true);
    onAdoptedRef.current?.(conversationId);
  }, [adopted, conversationId, messagesLength]);

  // ...and, separately, once that creating turn has SETTLED.
  const addressedRef = useRef(false);
  const onAddressableRef = useRef(onAddressable);
  useEffect(() => {
    onAddressableRef.current = onAddressable;
  }, [onAddressable]);
  useEffect(() => {
    if (adopted || !selfAdopted || isBusy || addressedRef.current) return;
    addressedRef.current = true;
    onAddressableRef.current?.(conversationId);
  }, [adopted, selfAdopted, isBusy, conversationId]);

  return { selfAdopted, adoptedNow };
}
