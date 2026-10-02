"use client";

import { Bot, Box, Loader2, Terminal } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { AppHeader } from "@/components/app-header";
import { SandboxStatus } from "@/components/sandbox-status";
import type { SandboxLink } from "@/db/sandbox-view";
import { shortSandboxId } from "@/lib/sandbox-id";
import { cn } from "@/lib/utils";

interface HarnessEvent {
  id: number;
  at: number;
  kind: string;
  toolName?: string | null;
  input?: string | null;
  output?: string | null;
  text?: string | null;
}

interface HarnessRun {
  sessionId: string;
  kind: string;
  status: string;
  toolCalls: number;
  startedAt: number;
  lastAt: number;
  error?: string | null;
}

/** One harness tool call, collapsed by default (ai-elements tool style). */
function HarnessToolCall({
  toolName,
  input,
  output,
}: {
  toolName: string;
  input?: string | null;
  output?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent/50"
      >
        <Terminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-mono">{toolName}</span>
        <span className="text-muted-foreground">
          {output !== undefined && output !== null ? "· completed" : "· running"}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {open ? "−" : "+"}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {input && (
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase text-muted-foreground">
                input
              </p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px]">
                {input}
              </pre>
            </div>
          )}
          {output && (
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase text-muted-foreground">
                output
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px]">
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The harness session view (0005/0006): one harness's event stream for
 * a conversation rendered conversation-style — turn boundaries, model
 * texts, tool calls with inputs/outputs — branded so it reads as a
 * distinct agent session. Polls incrementally (event-id cursor) while
 * the run is active.
 */
export function HarnessSessionView({
  initialRun,
  initialEvents,
  parent,
  sandbox,
}: {
  initialRun: HarnessRun;
  initialEvents: readonly HarnessEvent[];
  /** Where this session works: its chat's recorded sandbox or the run's. */
  sandbox: SandboxLink | null;
  /** The conversation that spawned this session (session id = its id). */
  parent: {
    id: string;
    title: string | null;
    exists: boolean;
    projectId: string | null;
    projectName: string | null;
  };
}) {
  const [run, setRun] = useState(initialRun);
  const [events, setEvents] = useState(initialEvents);

  useEffect(() => {
    if (run.status !== "running") return;
    const timer = setInterval(async () => {
      try {
        const after = events.length > 0 ? events[events.length - 1].id : 0;
        const params = new URLSearchParams({ harness: run.kind });
        if (after > 0) params.set("after", String(after));
        const res = await fetch(
          `/api/harness/${run.sessionId}?${params.toString()}`,
          { cache: "no-store" },
        );
        if (res.ok) {
          const body = (await res.json()) as {
            run: HarnessRun | null;
            events: HarnessEvent[];
          };
          if (body.run) setRun(body.run);
          if (body.events.length > 0) {
            setEvents((prev) => [...prev, ...body.events]);
          }
        }
      } catch {
        /* transient — keep polling */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [run.status, run.sessionId, run.kind, events]);

  const running = run.status === "running";
  const failed = run.status === "failed";

  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col">
      <AppHeader
        crumbs={[
          parent.projectId
            ? { label: parent.projectName ?? parent.projectId, href: `/p/${parent.projectId}` }
            : { label: "Chats", href: "/" },
          {
            label: parent.title ?? "Untitled chat",
            href: parent.exists ? `/c/${parent.id}` : undefined,
          },
          {
            label: (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-info/40 bg-info/10 px-2.5 py-0.5 text-xs font-medium text-info">
                <Bot className="size-3.5" aria-hidden />
                {run.kind} harness
              </span>
            ),
          },
        ]}
      >
        <span className="flex items-center gap-3 font-mono text-xs">
          {sandbox && (
            <Link
              href={`/sandboxes/${sandbox.id}`}
              title={`${sandbox.note} — ${sandbox.id}`}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
            >
              <Box className="size-3" aria-hidden />
              {shortSandboxId(sandbox.id)}
              <SandboxStatus status={sandbox.status} className="text-[10px]" />
            </Link>
          )}
          {running && <Loader2 className="size-3.5 animate-spin text-info" aria-hidden />}
          <span className={cn(running ? "text-info" : failed ? "text-destructive" : "text-success")}>
            {run.status}
          </span>
        </span>
      </AppHeader>
      {failed && run.error && (
        <p className="mx-4 mt-3 break-words rounded-md bg-destructive/10 px-2 py-1 font-mono text-[11px] text-destructive">
          {run.error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {events.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No harness activity recorded yet.
          </p>
        )}
        <div className="space-y-3">
          {events.map((event) => {
            if (event.kind === "start") {
              return (
                <p
                  key={event.id}
                  className="py-1 text-center font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
                >
                  — pi turn —
                </p>
              );
            }
            if (event.kind === "end") {
              return (
                <p
                  key={event.id}
                  className="py-1 text-center font-mono text-[10px] text-muted-foreground"
                >
                  ···
                </p>
              );
            }
            if (event.kind === "step-start") {
              return null;
            }
            if (event.kind === "step-end") {
              return event.text ? (
                <div
                  key={event.id}
                  className="rounded-lg bg-muted/40 px-3 py-2 text-sm"
                >
                  <MessageResponse>{event.text}</MessageResponse>
                </div>
              ) : null;
            }
            if (event.kind === "tool-start") {
              return (
                <HarnessToolCall
                  key={`t-${event.id}`}
                  toolName={event.toolName ?? "?"}
                  input={event.input}
                />
              );
            }
            if (event.kind === "tool-end") {
              return (
                <HarnessToolCall
                  key={`t-${event.id}`}
                  toolName={event.toolName ?? "?"}
                  output={event.output}
                />
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}
