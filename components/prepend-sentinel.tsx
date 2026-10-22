"use client";

import type { MutableRefObject, ReactNode } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import type { PrependAnchorTarget } from "@/lib/use-prepend-anchor";

/**
 * 0075: the top-of-content row a `usePrependAnchor` measures. Must render
 * inside <ConversationContent> — it reads the scroller from
 * use-stick-to-bottom's context. Children are the Load-earlier control.
 */
export function PrependSentinel({
  targetRef,
  children,
}: {
  targetRef: MutableRefObject<PrependAnchorTarget>;
  children: ReactNode;
}) {
  const { scrollRef } = useStickToBottomContext();
  return (
    <div
      ref={(el) => {
        targetRef.current.sentinel = el;
        targetRef.current.scrollRef = scrollRef;
      }}
      className="flex min-h-8 items-center justify-center py-2"
    >
      {children}
    </div>
  );
}
