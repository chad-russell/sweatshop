"use client";

import { Circle, CircleDot } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import type { UnreadThread } from "@/lib/read-models/attention";
import { conversationHref } from "@/lib/conversation-href";
import { Where } from "./where";

/**
 * An unread thread: title, where it lives, a clip of the newest assistant
 * message. Clicking opens the chat (which marks it read); the toggle
 * marks it read in place without leaving the dashboard.
 */
export function UnreadCard({
  thread,
  read,
  onToggle,
}: {
  thread: UnreadThread;
  /** Marked read during this visit — kept in place so it can be undone. */
  read: boolean;
  onToggle: (id: string, read: boolean) => void;
}) {
  return (
    <article
      className={cn(
        "group/card relative flex gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground transition-colors hover:bg-muted/40",
        read && "opacity-60",
      )}
    >
      {read ? (
        <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Read" />
      ) : (
        <CircleDot className="mt-0.5 size-4 shrink-0 text-primary" aria-label="Unread" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link
          href={conversationHref(thread)}
          className="truncate text-sm font-medium after:absolute after:inset-0 hover:underline"
        >
          {thread.label}
        </Link>
        <Where projectName={thread.projectName} path={thread.path} at={thread.at} />
        {thread.snippet && (
          <p className="line-clamp-3 text-sm text-muted-foreground">{thread.snippet}</p>
        )}
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        title={read ? "Mark unread" : "Mark read"}
        aria-label={`Mark ${thread.label} ${read ? "unread" : "read"}`}
        onClick={() => onToggle(thread.id, !read)}
        className="relative z-10 shrink-0"
      >
        {read ? <CircleDot /> : <Circle />}
      </Button>
    </article>
  );
}
