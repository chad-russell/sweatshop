"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatRoute } from "@/lib/providers/route";

/**
 * 0021: per conversation, not sticky across chats — a fresh chat
 * starts on the default (which /settings or the project decides). Sent
 * only once Chad picks, so the server's stored route is never clobbered.
 */
export function useRoute(initialRoute: ChatRoute | null | undefined) {
  const [route, setRoute] = useState<ChatRoute | null>(initialRoute ?? null);
  const [routeTouched, setRouteTouched] = useState(false);
  const selectRoute = (next: ChatRoute | null) => {
    setRoute(next);
    setRouteTouched(true);
  };

  // Turn the knob into a request field on every send. The ref is
  // synced in an effect (post-render); sends can only happen after
  // mount, so the value is always current when a request fires.
  const routeRef = useRef<{ touched: boolean; route: ChatRoute | null }>({ touched: false, route });
  useEffect(() => {
    routeRef.current = { touched: routeTouched, route };
  }, [route, routeTouched]);

  return { route, selectRoute, routeRef };
}
