"use client";

import { MessageCircleQuestion } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { NeedsYouThread, PendingRequest } from "@/db/attention";
import { Where } from "./where";
import { useRespond } from "./use-respond";

/**
 * A question the agent asked (`ask_question` / `ctx.ask()`): option
 * buttons when it offered choices, plus a free-text answer when allowed
 * (or when there are no options at all).
 */
export function QuestionCard({
  thread,
  request,
  onAnswered,
}: {
  thread: NeedsYouThread;
  request: PendingRequest;
  onAnswered: (requestId: string) => void;
}) {
  const { respond, busy, error } = useRespond(thread.id, request.runtime);
  const [text, setText] = useState("");
  const freeform = request.allowFreeform || request.options.length === 0;

  const answer = async (payload: { optionId?: string; text?: string }) => {
    const ok = await respond([{ requestId: request.requestId, ...payload }]);
    if (ok) onAnswered(request.requestId);
  };

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-info/50 bg-card p-4 text-card-foreground">
      <header className="flex flex-col gap-1">
        <Link
          href={`/c/${thread.id}`}
          className="truncate text-sm font-medium hover:underline"
        >
          {thread.title ?? thread.id}
        </Link>
        <Where projectName={thread.projectName} path={thread.path} at={request.at} />
      </header>
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-info" />
        <p className="min-w-0 flex-1 text-sm whitespace-pre-wrap">{request.prompt}</p>
      </div>
      {request.options.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {request.options.map((option) => (
            <Button
              key={option.id}
              variant="outline"
              disabled={busy}
              onClick={() => void answer({ optionId: option.id })}
              className="h-auto justify-start py-1.5 text-left whitespace-normal"
            >
              <span className="flex flex-col items-start">
                <span>{option.label}</span>
                {option.description && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </Button>
          ))}
        </div>
      )}
      {freeform && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const value = text.trim();
            if (value) void answer({ text: value });
          }}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={request.options.length > 0 ? "Or type your own answer…" : "Your answer…"}
            aria-label="Answer"
            disabled={busy}
          />
          <Button type="submit" size="default" disabled={busy || !text.trim()}>
            Send
          </Button>
        </form>
      )}
      <div className="flex items-center justify-end">
        <Button asChild size="sm" variant="ghost">
          <Link href={`/c/${thread.id}`}>Open thread</Link>
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}
