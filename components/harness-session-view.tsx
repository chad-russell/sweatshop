"use client";

import { Box, FileText } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { MessageResponse } from "@/components/ai-elements/message";
import { TransitionCard } from "@/components/ai-elements/agent-cards";
import { BashTerminal } from "@/components/ai-elements/bash-terminal";
import { CancelCallBar } from "@/components/cancel-call-button";
import { FileCard } from "@/components/ai-elements/file-card";
import { ListCard } from "@/components/ai-elements/list-card";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { ToolGroupView } from "@/components/ai-elements/tool-group";
import { AppHeader } from "@/components/app-header";
import { SandboxStatus } from "@/components/sandbox-status";
import { Spinner } from "@/components/ui/spinner";
import { PrependSentinel } from "@/components/prepend-sentinel";
import { usePrependAnchor, type PrependAnchorTarget } from "@/lib/use-prepend-anchor";
import { HARNESS_PAGE } from "@/lib/harness-paging";
import type { SandboxLink } from "@/lib/read-models/sandbox";
import { TaskQuote } from "@/components/harness-card";
import { HARNESS_LABEL, HarnessMark } from "@/components/harness-logo";
import { buildTimeline, timelineToParts, type FileChange, type TimelineItem } from "@/lib/harness-timeline";
import { fetchHarnessWindow } from "@/lib/api/harness";
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
  /** 0083: the lane this event's call ran in, null for the default lane. */
  dir?: string | null;
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
          <p className="flex items-center justify-center gap-1.5 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            — turn —
            {item.dir && (
              <span
                title={`ran as a lane at ${item.dir}`}
                className="inline-flex items-center rounded-full border border-border bg-muted/50 px-1.5 py-0.5 normal-case tracking-normal text-foreground"
              >
                {item.dir}
              </span>
            )}
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

/** Load-earlier control; must render inside <ConversationContent>. */
function OlderEventsControl({
  hasOlder,
  loading,
  onLoad,
  anchorRef,
}: {
  hasOlder: boolean;
  loading: boolean;
  onLoad: () => void;
  anchorRef: MutableRefObject<PrependAnchorTarget>;
}) {
  return (
    <PrependSentinel targetRef={anchorRef}>
      {!hasOlder ? (
        <span className="text-xs text-muted-foreground">Start of session</span>
      ) : loading ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Spinner className="size-3.5" aria-hidden />
          Loading…
        </span>
      ) : (
        <button
          type="button"
          onClick={onLoad}
          className="rounded text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          Load earlier
        </button>
      )}
    </PrependSentinel>
  );
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
  initialHasOlder = false,
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
  /** Whether events older than `initialEvents` exist (it's a tail window). */
  initialHasOlder?: boolean;
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
  const [hasOlder, setHasOlder] = useState(initialHasOlder);
  const [olderLoading, setOlderLoading] = useState(false);
  const [pagedOnce, setPagedOnce] = useState(false);
  const anchor = usePrependAnchor(events);

  /** The query params a per-call page adds (its event window). */
  const callWindow = () =>
    call
      ? {
          from: call.createdAt,
          ...(call.settledAt !== null ? { to: call.settledAt } : {}),
        }
      : {};

  /** Prepend the previous page and keep the viewport pinned (the chat's
   *  0075 anchor: scrollTop moves by exactly the height added above).
   *  The timeline is rebuilt over the whole merged list, so a tool call
   *  whose start lands in the new page re-pairs with its end. */
  const loadOlder = async () => {
    const oldest = events[0];
    if (olderLoading || !hasOlder || !oldest) return;
    setOlderLoading(true);
    setPagedOnce(true);
    anchor.capture();
    const page = await fetchHarnessWindow<HarnessEvent>(run.sessionId, {
      harness: run.kind,
      tail: HARNESS_PAGE,
      before: oldest.id,
      ...callWindow(),
    });
    if (!page) {
      anchor.cancel(); // failed — the button stays for a retry
      setOlderLoading(false);
      return;
    }
    setEvents((prev) => [...page.events.filter((e) => e.id < (prev[0]?.id ?? Infinity)), ...prev]);
    setHasOlder(page.hasOlder);
    anchor.commit(); // same batch as the prepend
    setOlderLoading(false);
  };

  useEffect(() => {
    if (run.status !== "running") return;
    const timer = setInterval(async () => {
      const after = events.length > 0 ? events[events.length - 1].id : 0;
      const page = await fetchHarnessWindow<HarnessEvent>(run.sessionId, {
        harness: run.kind,
        ...(after > 0 ? { after } : {}),
        ...callWindow(),
      });
      if (!page) return; // transient — keep polling
      if (page.run) setRun(page.run);
      if (page.events.length > 0) {
        setEvents((prev) => {
          const last = prev[prev.length - 1]?.id ?? 0;
          return [...prev, ...page.events.filter((e) => e.id > last)];
        });
      }
    }, 2000);
    return () => clearInterval(timer);
    // callWindow only reads `call`, already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          {!running && (
            <span className={cn(failed ? "text-destructive" : status === "cancelled" ? "text-muted-foreground" : "text-success")}>
              {status}
            </span>
          )}
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

      {/* Open AT the bottom — no visible scroll animation on load. */}
      <Conversation className="min-h-0 flex-1" initial="instant">
        <ConversationContent className="gap-3">
          {(hasOlder || pagedOnce) && (
            <OlderEventsControl
              hasOlder={hasOlder}
              loading={olderLoading}
              onLoad={() => void loadOlder()}
              anchorRef={anchor.targetRef}
            />
          )}
          <HarnessEventLog events={events} />
          {running && (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground" role="status">
              <Spinner className="size-4" />
              Working…
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {running && callId && <CancelCallBar callId={callId} label={HARNESS_LABEL[run.kind] ?? run.kind} />}
    </div>
  );
}
