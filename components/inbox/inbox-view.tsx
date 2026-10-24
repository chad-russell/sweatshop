"use client";

import { NavTrigger } from "@/components/sidebar/nav-drawer";
import { CheckCheck, InboxIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { markAllInboxRead, markConversationSeen } from "@/lib/api/conversations";
import type {
  InboxData,
  NeedsYouPreview,
  NeedsYouThread,
  PendingRequest,
  UnreadThread,
} from "@/lib/read-models/attention";
import { ApprovalCard } from "./approval-card";
import { OutlineReviewCard } from "./outline-card";
import { PreviewFailureCard } from "./preview-failure-card";
import { QuestionCard } from "./question-card";
import { UnreadCard } from "./unread-card";

type Needed =
  | { key: string; kind: "preview"; item: NeedsYouPreview }
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
 * "Needs you" — approvals, questions, failed branch
 * previews (0016) — comes first and
 * stays until answered; "Unread" is threads with assistant output you
 * haven't viewed. The shell (lib/use-attention-sync) refreshes this page
 * when the attention signature changes, so new asks appear without a reload.
 */
export function InboxView({ data }: { data: InboxData }) {
  const router = useRouter();
  // Optimistic hides between answering and the server recording it.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  // Threads marked read this visit, kept visible (dimmed) so the toggle
  // can undo it. Cleared on navigation away — the server is the truth.
  const [readHere, setReadHere] = useState<ReadonlyMap<string, UnreadThread>>(new Map());

  const setSeen = useCallback(
    async (thread: UnreadThread, seen: boolean) => {
      setReadHere((prev) => {
        const next = new Map(prev);
        if (seen) next.set(thread.id, thread);
        else next.delete(thread.id);
        return next;
      });
      await markConversationSeen(thread.id, seen);
      router.refresh();
    },
    [router],
  );

  const markAllRead = useCallback(async () => {
    setReadHere((prev) => new Map([...prev, ...data.unread.map((t) => [t.id, t] as const)]));
    await markAllInboxRead();
    router.refresh();
  }, [data.unread, router]);

  const answer = useCallback(
    (id: string) => {
      setAnswered((prev) => new Set(prev).add(id));
      // /api/x/input resolves the row before responding — refresh now.
      router.refresh();
    },
    [router],
  );

  const needs = data.needsYou.flatMap((item): Needed[] => {
    if (item.kind === "preview") {
      return answered.has(item.id) ? [] : [{ key: item.id, kind: "preview", item }];
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
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col gap-8 overflow-y-auto p-4 md:p-6">
      <header className="flex items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <NavTrigger className="-ml-2" />
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
            if (n.kind === "preview") {
              return <PreviewFailureCard key={n.key} item={n.item} onAnswered={answer} />;
            }
            if (n.request.kind === "outline") {
              return <OutlineReviewCard key={n.key} thread={n.thread} request={n.request} onAnswered={answer} />;
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
