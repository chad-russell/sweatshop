"use client";

import { CheckCheck, InboxIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  InboxData,
  NeedsYouThread,
  NeedsYouTicket,
  PendingRequest,
  UnreadThread,
} from "@/db/attention";
import { ApprovalCard } from "./approval-card";
import { QuestionCard } from "./question-card";
import { TicketGateCard } from "./ticket-gate-card";
import { UnreadCard } from "./unread-card";

const POLL_MS = 5000;

type Needed =
  | { key: string; kind: "ticket"; gate: NeedsYouTicket }
  | { key: string; kind: "request"; thread: NeedsYouThread; request: PendingRequest };

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-baseline gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
        <span className="font-mono">{count}</span>
      </h2>
      {children}
    </section>
  );
}

/**
 * The Inbox dashboard (0008): everything waiting on you, in one place.
 * "Needs you" — approvals, questions, ticket gates — comes first and
 * stays until answered; "Unread" is threads with assistant output you
 * haven't viewed. Server data is re-read on a short poll while the tab is
 * visible, so new asks appear without a reload.
 */
export function InboxView({ data }: { data: InboxData }) {
  const router = useRouter();
  // Optimistic hides between answering and the server recording it.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  // Threads marked read this visit, kept visible (dimmed) so the toggle
  // can undo it. Cleared on navigation away — the server is the truth.
  const [readHere, setReadHere] = useState<ReadonlyMap<string, UnreadThread>>(new Map());

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router]);

  const setSeen = useCallback(
    async (thread: UnreadThread, seen: boolean) => {
      setReadHere((prev) => {
        const next = new Map(prev);
        if (seen) next.set(thread.id, thread);
        else next.delete(thread.id);
        return next;
      });
      await fetch(`/api/conversations/${thread.id}/seen`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seen }),
      });
      router.refresh();
    },
    [router],
  );

  const markAllRead = useCallback(async () => {
    setReadHere((prev) => new Map([...prev, ...data.unread.map((t) => [t.id, t] as const)]));
    await fetch("/api/inbox/mark-all-read", { method: "POST" });
    router.refresh();
  }, [data.unread, router]);

  const answer = useCallback(
    (id: string) => {
      setAnswered((prev) => new Set(prev).add(id));
      // The mirror records input.resolved just after eve accepts the reply.
      setTimeout(() => router.refresh(), 800);
    },
    [router],
  );

  const needs = data.needsYou.flatMap((item): Needed[] => {
    if (item.kind === "ticket") {
      return answered.has(item.id) ? [] : [{ key: item.id, kind: "ticket", gate: item }];
    }
    return item.requests
      .filter((r) => !answered.has(r.requestId))
      .map((request) => ({ key: request.requestId, kind: "request", thread: item, request }));
  });
  // Server-unread threads, plus the ones just marked read here (in place).
  const unread = [
    ...data.unread.filter((t) => !readHere.has(t.id)),
    ...readHere.values(),
  ].sort((a, b) => b.at - a.at);
  const unreadLeft = unread.filter((t) => !readHere.has(t.id)).length;
  const empty = needs.length === 0 && unread.length === 0;

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-8 overflow-y-auto p-6">
      <header className="flex items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <InboxIcon className="size-5" />
          Inbox
        </h1>
        {unreadLeft > 0 && (
          <Button size="sm" variant="ghost" onClick={() => void markAllRead()}>
            <CheckCheck />
            Mark all read
          </Button>
        )}
      </header>

      {empty && (
        <p className="text-sm text-muted-foreground">
          All caught up — nothing is waiting on you.
        </p>
      )}

      {needs.length > 0 && (
        <Section title="Needs you" count={needs.length}>
          {needs.map((n) => {
            if (n.kind === "ticket") {
              return <TicketGateCard key={n.key} gate={n.gate} onAnswered={answer} />;
            }
            return n.request.kind === "question" ? (
              <QuestionCard key={n.key} thread={n.thread} request={n.request} onAnswered={answer} />
            ) : (
              <ApprovalCard key={n.key} thread={n.thread} request={n.request} onAnswered={answer} />
            );
          })}
        </Section>
      )}

      {unread.length > 0 && (
        <Section title="Unread" count={unreadLeft}>
          {unread.map((thread) => (
            <UnreadCard
              key={thread.id}
              thread={thread}
              read={readHere.has(thread.id)}
              onToggle={(_, seen) => void setSeen(thread, seen)}
            />
          ))}
        </Section>
      )}
    </div>
  );
}
