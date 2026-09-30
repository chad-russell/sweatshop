"use client";

import { Bot, Loader2, Terminal } from "lucide-react";
import { useEffect, useState } from "react";

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
 * The pi (harness) session view (0005): the harness event stream rendered
 * conversation-style — turn boundaries, model texts, tool calls with
 * inputs/outputs — branded so it reads as a distinct agent session.
 * Polls while the run is active.
 */
export function HarnessSessionView({
  initialRun,
  initialEvents,
}: {
  initialRun: HarnessRun;
  initialEvents: readonly HarnessEvent[];
}) {
  const [run, setRun] = useState(initialRun);
  const [events, setEvents] = useState(initialEvents);

  useEffect(() => {
    if (run.status !== "running") return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/harness/${run.sessionId}`, {
          cache: "no-store",
        });
        if (res.ok) {
          const body = (await res.json()) as {
            run: HarnessRun | null;
            events: HarnessEvent[];
          };
          if (body.run) setRun(body.run);
          setEvents(body.events);
        }
      } catch {
        /* transient — keep polling */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [run.status, run.sessionId]);

  const running = run.status === "running";

  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col">
      <header className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-info/40 bg-info/10 px-2.5 py-0.5 text-xs font-medium text-info">
              <Bot className="size-3.5" aria-hidden />
              {run.kind} harness session
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {run.sessionId}
            </span>
          </span>
          <span className="flex items-center gap-2 font-mono text-xs">
            {running && (
              <Loader2 className="size-3.5 animate-spin text-info" aria-hidden />
            )}
            <span className={running ? "text-info" : "text-success"}>
              {run.status}
            </span>
            <span className="text-muted-foreground">{run.toolCalls} calls</span>
          </span>
        </div>
      </header>

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
                  {event.text}
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
