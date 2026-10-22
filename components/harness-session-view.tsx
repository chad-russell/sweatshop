"use client";

import { Box, FileText, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { TransitionCard } from "@/components/ai-elements/agent-cards";
import { BashTerminal } from "@/components/ai-elements/bash-terminal";
import { CancelCallButton } from "@/components/cancel-call-button";
import { FileCard } from "@/components/ai-elements/file-card";
import { ListCard } from "@/components/ai-elements/list-card";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { ToolGroupView } from "@/components/ai-elements/tool-group";
import { AppHeader } from "@/components/app-header";
import { SandboxStatus } from "@/components/sandbox-status";
import type { SandboxLink } from "@/lib/read-models/sandbox";
import { TaskQuote } from "@/components/harness-card";
import { HARNESS_LABEL, HarnessMark } from "@/components/harness-logo";
import { topInScroller } from "@/lib/anchor-scroll";
import { buildTimeline, timelineToParts, type FileChange, type TimelineItem } from "@/lib/harness-timeline";
import { shortSandboxId } from "@/lib/sandbox-id";
import { groupParts } from "@/lib/tool-views/groups";
import { cn } from "@/lib/utils";

export interface HarnessEvent {
  id: number;
  at: number;
  kind: string;
  toolName?: string | null;
  toolCallId?: string | null;
  input?: string | null;
  output?: string | null;
  text?: string | null;
}

export interface HarnessRun {
  sessionId: string;
  kind: string;
  status: string;
  toolCalls: number;
  startedAt: number;
  lastAt: number;
  error?: string | null;
}

function parseMaybeJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value; // clipped mid-JSON or plain text
  }
}

/** Tools whose output is text to show verbatim — a JSON file read must not be parsed away. */
const RAW_OUTPUT_TOOLS = new Set(["read", "ls", "grep", "glob", "find"]);

const CHANGE_LABEL: Record<string, string> = {
  add: "created",
  create: "created",
  created: "created",
  update: "modified",
  modify: "modified",
  modified: "modified",
  change: "modified",
  delete: "deleted",
  deleted: "deleted",
};

/** A file the harness reported changing — a chip, not a call of its own. */
function FileChangeChip({ change }: { change: FileChange }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
      <FileText className="size-3 shrink-0" aria-hidden />
      <span className="shrink-0">{CHANGE_LABEL[change.event] ?? change.event}</span>
      <span className="truncate text-foreground">{change.path}</span>
    </span>
  );
}

/** One harness tool call: a single card whose state follows the call. */
function HarnessToolCall({ item }: { item: Extract<TimelineItem, { type: "tool" }> }) {
  const input = parseMaybeJson(item.input);
  const output = RAW_OUTPUT_TOOLS.has(item.toolName) ? (item.output ?? undefined) : parseMaybeJson(item.output);
  const state =
    item.state === "completed"
      ? "output-available"
      : item.state === "error"
        ? "output-error"
        : "input-available";
  const cardState = item.state === "error" ? "error" : item.state === "completed" ? "completed" : "running";
  const errorText = item.state === "error" ? String(item.output ?? "tool failed") : undefined;
  const plainOutput = item.state === "error" ? undefined : output;
  if (item.toolName === "write" || item.toolName === "edit" || item.toolName === "read") {
    // pi's write output doesn't say create vs overwrite; its fileChange event does.
    const ev = item.changes[0]?.event;
    const hint = ev && /^(add|create)/.test(ev) ? "create" : ev ? "update" : undefined;
    return (
      <FileCard
        tool={item.toolName}
        state={cardState}
        input={input}
        output={plainOutput}
        errorText={errorText}
        hintChange={hint}
      />
    );
  }
  if (item.toolName === "ls" || item.toolName === "grep" || item.toolName === "glob" || item.toolName === "find") {
    return (
      <ListCard tool={item.toolName} state={cardState} input={input} output={plainOutput} errorText={errorText} />
    );
  }
  if (item.toolName === "transition") {
    return <TransitionCard state={cardState} input={input} output={plainOutput} errorText={errorText} />;
  }
  if (item.toolName === "bash") {
    return (
      <BashTerminal
        state={state}
        input={input}
        output={item.state === "error" ? undefined : output}
        errorText={item.state === "error" ? String(item.output ?? "tool failed") : undefined}
      />
    );
  }
  return (
    <Tool className={cn("mb-0", item.state === "error" && "border-destructive/40")}>
      <ToolHeader
        type="dynamic-tool"
        state={state}
        toolName={item.toolName}
        extra={
          item.changes.length > 0 ? (
            <span className="flex min-w-0 flex-wrap justify-end gap-1">
              {item.changes.map((c, i) => (
                <FileChangeChip key={i} change={c} />
              ))}
            </span>
          ) : undefined
        }
      />
      <ToolContent>
        {input !== undefined && <ToolInput input={input} />}
        {output !== undefined && (
          <ToolOutput
            output={item.state === "error" ? undefined : (output as never)}
            errorText={item.state === "error" ? String(item.output ?? "tool failed") : undefined}
          />
        )}
      </ToolContent>
    </Tool>
  );
}

/** One timeline item, rendered the same whether it stands alone or is
 *  opened from inside a quiet-calls group. */
function HarnessTimelineEntry({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case "turn-start":
      return (
        <div className="space-y-2">
          <p className="py-1 text-center font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            — turn —
          </p>
          {/* What the harness was asked — the same quote as its chat card. */}
          {item.task && (
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-lg bg-secondary px-3 py-2">
                <TaskQuote className="border-l-0 pl-0 text-foreground">{item.task}</TaskQuote>
              </div>
            </div>
          )}
        </div>
      );
    case "turn-end":
      return <p className="py-1 text-center font-mono text-[10px] text-muted-foreground">···</p>;
    case "text":
      return (
        <div className="rounded-lg bg-muted/40 px-3 py-2 text-sm">
          <MessageResponse>{item.text}</MessageResponse>
        </div>
      );
    case "tool":
      return <HarnessToolCall item={item} />;
    case "file-change":
      return (
        <div className="flex">
          <FileChangeChip change={item.change} />
        </div>
      );
    case "compaction":
      return (
        <p className="py-1 text-center font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          — context compacted —
        </p>
      );
  }
}

/** A harness session's events, conversation-style (also the 0012 run
 *  view's side panel). Raw rows are folded into one item per tool call,
 *  then quiet read-only runs are folded again into one collapsible group
 *  (0056's `groupParts`/`ToolGroupView` — the same allow-list the chat
 *  transcript uses, via `timelineToParts`). */
export function HarnessEventLog({ events }: { events: readonly HarnessEvent[] }) {
  const items = useMemo(() => buildTimeline(events), [events]);
  const segments = useMemo(() => groupParts(timelineToParts(items)), [items]);
  return (
    <>
      {items.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No harness activity recorded yet.
        </p>
      )}
      <div className="space-y-3">
        {segments.map((seg) =>
          seg.kind === "group" ? (
            <ToolGroupView
              key={`g-${items[seg.index]!.id}`}
              group={seg}
              render={(entry) => <HarnessTimelineEntry item={items[entry.index]!} />}
            />
          ) : (
            <HarnessTimelineEntry key={`p-${items[seg.index]!.id}`} item={items[seg.index]!} />
          ),
        )}
      </div>
    </>
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
  initialOlderCursor,
  initialRemaining,
  parent,
  sandbox,
  call,
  callId,
}: {
  initialRun: HarnessRun;
  /** 0046: set on the per-call page — scopes polling to the call's window
   *  so an old call never appends a later call's events. */
  call?: { id: string; task: string; status: string; createdAt: number; settledAt: number | null };
  /** 0063: the hc_… call to cancel while it's running — the per-call
   *  page's own call, or (on the session page) the session's newest
   *  running call of this kind. Absent = no Cancel button. */
  callId?: string;
  initialEvents: readonly HarnessEvent[];
  /** 0075: the tail page's before-cursor — the id an older page starts
   *  strictly below. Null (or absent) = the whole log is hydrated. */
  initialOlderCursor?: number | null;
  /** How many older events sit before the tail page (the "~N more"). */
  initialRemaining?: number;
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
  // 0075 load-earlier: the current before-cursor and the older count the
  // control hints at; the anchor keeps the viewport pinned across a
  // prepend (measured off the log's first element, plain DOM).
  const [olderCursor, setOlderCursor] = useState<number | null>(initialOlderCursor ?? null);
  const [remaining, setRemaining] = useState(initialRemaining ?? 0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Bumped with the events update so the layout effect below runs after
  // exactly that commit (a rAF can fire before React flushes updates
  // started from an async continuation — the layout effect cannot).
  const [anchorTick, setAnchorTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  // The first event element at click time + where it sat in the scroll
  // container's content — after the prepend it (still in the DOM, its
  // key stable) has moved down by exactly the prepended height. If the
  // page boundary folded the anchor item away (a split tool pair joins
  // its start), fall back to the content-height delta.
  const pendingAnchorRef = useRef<{
    first: Element;
    firstTop: number;
    scrollTop: number;
    height: number;
  } | null>(null);

  // Position within the scroller's content space: shared rect-delta math
// (lib/anchor-scroll.ts, invariant to the container's own scroll/page
// position).

  // The first rendered ITEM, not a wrapper: HarnessEventLog nests its
  // items in one list container (div.space-y-3) whose top edge never
  // moves — the first item inside it is what prepends push down.
  const firstItem = (log: HTMLElement | null): Element | null =>
    (log?.querySelector(":scope > .space-y-3") ?? log)?.firstElementChild ?? null;

  const loadOlder = async () => {
    if (olderCursor === null || loadingOlder) return;
    const scroll = scrollRef.current;
    const first = firstItem(logRef.current);
    if (scroll && first) {
      pendingAnchorRef.current = {
        first,
        firstTop: topInScroller(scroll, first),
        scrollTop: scroll.scrollTop,
        height: scroll.scrollHeight,
      };
    }
    setLoadingOlder(true);
    try {
      const params = new URLSearchParams({ harness: run.kind, before: String(olderCursor) });
      if (call) {
        params.set("from", String(call.createdAt));
        if (call.settledAt !== null) params.set("to", String(call.settledAt));
      }
      const res = await fetch(`/api/harness/${run.sessionId}?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        pendingAnchorRef.current = null; // transient — retry re-measures
        return;
      }
      const body = (await res.json()) as {
        events: HarnessEvent[];
        cursor: number | null;
        remaining: number;
      };
      setOlderCursor(body.cursor);
      setRemaining(body.remaining);
      if (body.events.length > 0) {
        // Prepend deduped by id — a page's ids are strictly below the
        // window, so ascending order holds; the dedup guards a poll/page
        // race around the window's edge.
        setEvents((prev) => {
          const known = new Set(prev.map((e) => e.id));
          return [...body.events.filter((e) => !known.has(e.id)), ...prev];
        });
        setAnchorTick((t) => t + 1);
      } else {
        pendingAnchorRef.current = null; // nothing prepended — nothing to hold
      }
    } catch {
      pendingAnchorRef.current = null; // transient — the control shows again
    } finally {
      setLoadingOlder(false);
    }
  };
  // After the prepended events commit, restore the anchor: the same
  // first event moved down by exactly the prepended height, so the
  // scroll top follows it — the viewport never jumps.
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    const scroll = scrollRef.current;
    if (!pending || !scroll) return;
    pendingAnchorRef.current = null;
    const delta = pending.first.isConnected
      ? topInScroller(scroll, pending.first) - pending.firstTop
      : scroll.scrollHeight - pending.height; // anchor folded away by the merge
    scroll.scrollTop = pending.scrollTop + delta;
  }, [anchorTick]);

  useEffect(() => {
    if (run.status !== "running") return;
    const timer = setInterval(async () => {
      try {
        const after = events.length > 0 ? events[events.length - 1].id : 0;
        const params = new URLSearchParams({ harness: run.kind });
        if (after > 0) params.set("after", String(after));
        if (call) {
          params.set("from", String(call.createdAt));
          if (call.settledAt !== null) params.set("to", String(call.settledAt));
        }
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
  }, [run.status, run.sessionId, run.kind, events, call]);

  // On a per-call page a settled call shows its own status, not the
  // session's latest.
  const status = call && call.status !== "running" ? call.status : run.status;
  const running = status === "running";
  const failed = status === "failed";

  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col">
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
                <HarnessMark kind={run.kind} tint={false} className="size-3.5" />
                {HARNESS_LABEL[run.kind] ?? run.kind}
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
          <span
            className={cn(
              running ? "text-info" : failed ? "text-destructive" : status === "cancelled" ? "text-muted-foreground" : "text-success",
            )}
          >
            {status}
          </span>
          {running && callId && <CancelCallButton callId={callId} label={HARNESS_LABEL[run.kind] ?? run.kind} />}
        </span>
      </AppHeader>
      {call?.task && (
        <div className="mx-4 mt-3">
          <TaskQuote className="text-foreground">{call.task}</TaskQuote>
        </div>
      )}
      {failed && run.error && !call && (
        <p className="mx-4 mt-3 break-words rounded-md bg-destructive/10 px-2 py-1 font-mono text-[11px] text-destructive">
          {run.error}
        </p>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {/* 0075: the load-earlier control — only when older events remain
            under the current cursor (hidden once the log is exhausted). */}
        {olderCursor !== null && (
          <div className="flex min-h-8 items-center justify-center py-2">
            {loadingOlder ? (
              <span
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Loading…
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void loadOlder()}
                className="rounded text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                Load earlier events{remaining > 0 ? ` (~${remaining} more)` : ""}
              </button>
            )}
          </div>
        )}
        <div ref={logRef}>
          <HarnessEventLog events={events} />
        </div>
      </div>
    </div>
  );
}
