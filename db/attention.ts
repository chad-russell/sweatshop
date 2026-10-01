import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./index";
import { OrganizeError, folderPath } from "./organize";
import {
  conversationEvents,
  conversations,
  folders,
  machineRuns,
  machineStageRuns,
  messages,
  pendingInputs,
  projects,
} from "./schema";
import type { MachineDefinition } from "../lib/machines/definition";

/**
 * 0008 attention: what is waiting on the user.
 *
 *  - **Unread** — a conversation with an assistant message newer than
 *    `conversations.last_seen_at`. Opening a conversation (while the tab
 *    is visible and focused) marks it seen; it can be marked unread again.
 *  - **Needs you** — a pending human-input request (tool approval,
 *    question, session limit) or a machine run waiting at a human stage
 *    (0009 — machines replaced the 0004 ticket pipeline and its gate).
 *    Opening the thread does NOT clear it; only answering does.
 *
 * Pending requests are *derived* from the mirrored `input.requested` /
 * `input.resolved` events (the mirror stays a pure projection — nothing is
 * stored). A request is pending until a later `input.resolved` names its
 * id, the context is cleared, or the session ends.
 */

type Conn = Pick<Db, "select" | "insert" | "update" | "delete">;

export interface RequestOption {
  id: string;
  label: string;
  description?: string;
  style?: "danger" | "default" | "primary";
}

export interface PendingRequest {
  requestId: string;
  kind: "tool-approval" | "question" | "session-limit";
  prompt: string;
  options: RequestOption[];
  allowFreeform: boolean;
  /** The tool call behind the request (approvals), when present. */
  toolName: string | null;
  toolInput: Record<string, unknown> | null;
  /** Unix ms the request was raised. */
  at: number;
  /**
   * Which runtime raised it: "eve" (mirrored input events — answered on
   * /eve/v1/session) or "chat" (0010 pending_inputs — answered on
   * /api/x/input). Absent means eve (pre-0010 rows and callers).
   */
  runtime?: "eve" | "chat";
}

export interface EventRow {
  type: string;
  event: string;
  at: number;
}

const KINDS = new Set(["tool-approval", "question", "session-limit"]);

function asRequest(raw: unknown, at: number): PendingRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.requestId !== "string" || typeof r.kind !== "string") return null;
  if (!KINDS.has(r.kind)) return null;
  const action = r.action as { toolName?: unknown; input?: unknown } | undefined;
  const options = Array.isArray(r.options)
    ? r.options.flatMap((o): RequestOption[] => {
        if (!o || typeof o !== "object") return [];
        const opt = o as Record<string, unknown>;
        if (typeof opt.id !== "string" || typeof opt.label !== "string") return [];
        return [
          {
            id: opt.id,
            label: opt.label,
            ...(typeof opt.description === "string" ? { description: opt.description } : {}),
            ...(opt.style === "danger" || opt.style === "primary" || opt.style === "default"
              ? { style: opt.style }
              : {}),
          },
        ];
      })
    : [];
  return {
    requestId: r.requestId,
    kind: r.kind as PendingRequest["kind"],
    prompt: typeof r.prompt === "string" ? r.prompt : "",
    options,
    allowFreeform: r.allowFreeform === true,
    toolName: typeof action?.toolName === "string" ? action.toolName : null,
    toolInput:
      action?.input && typeof action.input === "object" && !Array.isArray(action.input)
        ? (action.input as Record<string, unknown>)
        : null,
    at,
  };
}

/**
 * Fold one conversation's `input.*` / terminal events (in stream order)
 * into the requests still awaiting an answer. Pure — exported for tests.
 */
export function pendingFromEvents(rows: readonly EventRow[]): PendingRequest[] {
  const pending = new Map<string, PendingRequest>();
  for (const row of rows) {
    let parsed: { data?: Record<string, unknown> };
    try {
      parsed = JSON.parse(row.event) as { data?: Record<string, unknown> };
    } catch {
      continue;
    }
    switch (row.type) {
      case "input.requested": {
        const requests = parsed.data?.requests;
        if (!Array.isArray(requests)) break;
        for (const raw of requests) {
          const request = asRequest(raw, row.at);
          if (request) pending.set(request.requestId, request);
        }
        break;
      }
      case "input.resolved": {
        const resolutions = parsed.data?.resolutions;
        if (!Array.isArray(resolutions)) break;
        for (const res of resolutions) {
          const id = (res as { requestId?: unknown } | null)?.requestId;
          if (typeof id === "string") pending.delete(id);
        }
        break;
      }
      case "context.cleared":
      case "session.completed":
      case "session.failed":
        pending.clear();
        break;
    }
  }
  return [...pending.values()].sort((a, b) => a.at - b.at);
}

const INPUT_EVENT_TYPES = [
  "input.requested",
  "input.resolved",
  "context.cleared",
  "session.completed",
  "session.failed",
];

/** Pending requests per conversation (only conversations with any). */
export function loadPendingRequests(
  db: Conn,
  onlyIds?: readonly string[],
): Map<string, PendingRequest[]> {
  const rows = db
    .select({
      conversationId: conversationEvents.conversationId,
      type: conversationEvents.type,
      event: conversationEvents.event,
      at: conversationEvents.at,
    })
    .from(conversationEvents)
    .where(
      onlyIds
        ? and(
            inArray(conversationEvents.type, INPUT_EVENT_TYPES),
            inArray(conversationEvents.conversationId, [...onlyIds]),
          )
        : inArray(conversationEvents.type, INPUT_EVENT_TYPES),
    )
    // Ingestion order is the implicit rowid (see the schema note).
    .orderBy(asc(sql`rowid`))
    .all();

  const byConversation = new Map<string, EventRow[]>();
  for (const { conversationId, ...row } of rows) {
    const list = byConversation.get(conversationId) ?? [];
    list.push(row);
    byConversation.set(conversationId, list);
  }
  const out = new Map<string, PendingRequest[]>();
  for (const [id, list] of byConversation) {
    const pending = pendingFromEvents(list);
    if (pending.length > 0) out.set(id, pending);
  }
  mergePendingInputs(db, out);
  return out;
}

/**
 * 0010 Phase 4: fold the new chat runtime's pending_inputs rows into the
 * same attention shape. They answer on /api/x/input (the runtime field
 * routes the card), not eve's channel route.
 */
function mergePendingInputs(db: Conn, out: Map<string, PendingRequest[]>): void {
  const rows = db
    .select({
      id: pendingInputs.id,
      conversationId: pendingInputs.conversationId,
      kind: pendingInputs.kind,
      question: pendingInputs.question,
      createdAt: pendingInputs.createdAt,
    })
    .from(pendingInputs)
    .where(isNull(pendingInputs.resolvedAt))
    .all();
  for (const row of rows) {
    const list = out.get(row.conversationId) ?? [];
    // kind "question" renders the freeform question card; anything else
    // is an approval with Approve/Deny.
    const isQuestion = row.kind === "question";
    list.push({
      requestId: row.id,
      kind: isQuestion ? "question" : "tool-approval",
      prompt: row.question,
      options: isQuestion
        ? []
        : [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "deny", label: "Deny", style: "danger" },
          ],
      allowFreeform: true,
      toolName: "ask_chad",
      toolInput: { kind: row.kind, question: row.question },
      at: row.createdAt,
      runtime: "chat",
    });
    out.set(row.conversationId, list);
  }
}

/** Newest assistant message time per conversation. */
function latestAssistantAt(db: Conn): Map<string, number> {
  const rows = db
    .select({
      conversationId: messages.conversationId,
      at: sql<number>`max(${messages.at})`,
    })
    .from(messages)
    .where(eq(messages.role, "assistant"))
    .groupBy(messages.conversationId)
    .all();
  return new Map(rows.map((r) => [r.conversationId, r.at]));
}

export interface AttentionState {
  /** Live (not archived/trashed) conversations with unread assistant output. */
  unread: Set<string>;
  /** Conversations with ≥1 pending request (archived ones included —
   *  an approval blocks work whether or not the thread is filed away). */
  needsYou: Set<string>;
  /** Machine runs waiting at a human stage (0009). */
  machineGates: number;
  /**
   * Changes iff anything the sidebar dots or the Inbox page show changed
   * (unread set, pending request ids, machine gates). Clients poll it
   * cheaply and refresh only on a difference.
   */
  signature: string;
}

export function loadAttention(db: Conn): AttentionState {
  const latest = latestAssistantAt(db);
  const rows = db
    .select({
      id: conversations.id,
      lastSeenAt: conversations.lastSeenAt,
      archivedAt: conversations.archivedAt,
      trashedAt: conversations.trashedAt,
    })
    .from(conversations)
    .all();
  const live = new Map(rows.filter((r) => !r.trashedAt).map((r) => [r.id, r]));
  const pending = loadPendingRequests(db);

  const unread = new Set<string>();
  for (const r of live.values()) {
    if (r.archivedAt) continue;
    const at = latest.get(r.id);
    if (at !== undefined && at > r.lastSeenAt) unread.add(r.id);
  }
  const needsYou = new Set([...pending.keys()].filter((id) => live.has(id)));
  const machineGateIds = waitingMachineGates(db).map((g) => g.token);
  const requestIds = [...pending.entries()]
    .filter(([id]) => live.has(id))
    .flatMap(([, list]) => list.map((r) => r.requestId));
  const signature = [
    [...unread].sort().join(","),
    requestIds.sort().join(","),
    machineGateIds.sort().join(","),
  ].join("|");
  return { unread, needsYou, machineGates: machineGateIds.length, signature };
}

// ---------------------------------------------------------------------
// Mutations

/**
 * Mark a conversation seen now (never moves `last_seen_at` backwards).
 * Returns whether it was unread before — callers refresh the sidebar
 * only when something actually changed.
 */
export function markSeen(db: Conn, id: string, at: number = Date.now()): boolean {
  const row = db
    .select({ lastSeenAt: conversations.lastSeenAt })
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  if (!row) throw new OrganizeError("not-found", `conversation ${id} not found`);
  const latest = latestAssistantAt(db).get(id);
  const wasUnread = latest !== undefined && latest > row.lastSeenAt;
  db.update(conversations)
    .set({ lastSeenAt: sql`max(${conversations.lastSeenAt}, ${at})` })
    .where(eq(conversations.id, id))
    .run();
  return wasUnread;
}

/**
 * Mark a conversation unread: rewind `last_seen_at` to just before its
 * newest assistant message. A conversation with no assistant output has
 * nothing to be unread about — returns false and changes nothing.
 */
export function markUnread(db: Conn, id: string): boolean {
  const exists = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  if (!exists) throw new OrganizeError("not-found", `conversation ${id} not found`);
  const latest = latestAssistantAt(db).get(id);
  if (latest === undefined) return false;
  db.update(conversations)
    .set({ lastSeenAt: latest - 1 })
    .where(eq(conversations.id, id))
    .run();
  return true;
}

/** Mark every live conversation seen (the "mark all read" button). */
export function markAllSeen(db: Conn, at: number = Date.now()): void {
  db.update(conversations)
    .set({ lastSeenAt: sql`max(${conversations.lastSeenAt}, ${at})` })
    .where(and(isNull(conversations.trashedAt), isNull(conversations.archivedAt)))
    .run();
}

// ---------------------------------------------------------------------
// Inbox page read model

interface Where {
  projectName: string | null;
  /** Folder breadcrumb, e.g. ["Spikes", "Sandbox"]. */
  path: string[];
}

export interface NeedsYouThread extends Where {
  kind: "thread";
  id: string;
  title: string | null;
  requests: PendingRequest[];
  /** Raised-at of the oldest pending request. */
  since: number;
  /** Also has unread assistant output (still shown once, here). */
  unread: boolean;
}

/** A machine run waiting at a human stage (0009). */
export interface NeedsYouMachineGate {
  kind: "machine";
  /** Visit token `<runId>:<seq>` — stable card key. */
  id: string;
  runId: string;
  seq: number;
  machineName: string;
  stageTitle: string;
  instructions: string;
  targets: { to: string; when?: string }[];
  prompt: string;
  /** The previous stage's outcome — usually what Chad is judging. */
  lastOutcome: string | null;
  projectName: string | null;
  since: number;
}

export interface UnreadThread extends Where {
  id: string;
  title: string | null;
  /** Newest assistant message, clipped. */
  snippet: string;
  /** Unix ms of that message. */
  at: number;
}

export interface InboxData {
  needsYou: (NeedsYouThread | NeedsYouMachineGate)[];
  unread: UnreadThread[];
}

const SNIPPET_MAX = 280;

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > SNIPPET_MAX
    ? `${collapsed.slice(0, SNIPPET_MAX - 1).trimEnd()}…`
    : collapsed;
}

export function loadInbox(db: Conn): InboxData {
  const attention = loadAttention(db);
  const projectName = new Map(
    db.select({ id: projects.id, name: projects.name }).from(projects).all().map((p) => [p.id, p.name]),
  );
  const folderIndex = new Map(
    db.select().from(folders).all().map((f) => [f.id, f]),
  );
  const rows = db
    .select({
      id: conversations.id,
      title: conversations.title,
      projectId: conversations.projectId,
      folderId: conversations.folderId,
    })
    .from(conversations)
    .all();
  const meta = new Map(rows.map((r) => [r.id, r]));
  const where = (id: string): Where => {
    const r = meta.get(id);
    return {
      projectName: r?.projectId ? (projectName.get(r.projectId) ?? r.projectId) : null,
      path: folderPath(folderIndex, r?.folderId ?? null),
    };
  };

  const pending = loadPendingRequests(db, [...attention.needsYou]);
  const threads: NeedsYouThread[] = [...attention.needsYou].map((id) => {
    const requests = pending.get(id) ?? [];
    return {
      kind: "thread",
      id,
      title: meta.get(id)?.title ?? null,
      requests,
      since: requests[0]?.at ?? 0,
      unread: attention.unread.has(id),
      ...where(id),
    };
  });

  const machineGates: NeedsYouMachineGate[] = waitingMachineGates(db).map((g) => {
    const definition = JSON.parse(g.definition) as MachineDefinition;
    const stage = definition.stages[g.stageId];
    const previous = db
      .select({ outcome: machineStageRuns.outcome })
      .from(machineStageRuns)
      .where(and(eq(machineStageRuns.runId, g.runId), eq(machineStageRuns.seq, g.seq - 1)))
      .get();
    return {
      kind: "machine",
      id: g.token,
      runId: g.runId,
      seq: g.seq,
      machineName: g.machineName,
      stageTitle: stage?.title ?? g.stageId,
      instructions: stage?.instructions ?? "",
      targets: stage?.next ?? [],
      prompt: g.prompt,
      lastOutcome: previous?.outcome ?? null,
      projectName: g.projectId ? (projectName.get(g.projectId) ?? g.projectId) : null,
      since: g.startedAt,
    };
  });

  const needsYou = [...threads, ...machineGates].sort((a, b) => a.since - b.since);

  // A thread that needs an answer is shown once, above; Unread is the rest.
  const unreadIds = [...attention.unread].filter((id) => !attention.needsYou.has(id));
  const unread: UnreadThread[] = unreadIds.flatMap((id) => {
    const last = db
      .select({ text: messages.text, at: messages.at })
      .from(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.role, "assistant")))
      .orderBy(sql`${messages.at} desc`)
      .limit(1)
      .get();
    if (!last) return [];
    return [
      {
        id,
        title: meta.get(id)?.title ?? null,
        snippet: clip(last.text),
        at: last.at,
        ...where(id),
      },
    ];
  });
  unread.sort((a, b) => b.at - a.at);

  return { needsYou, unread };
}

/** Human stage visits whose run is waiting on Chad (0009). */
function waitingMachineGates(db: Conn) {
  return db
    .select({
      runId: machineStageRuns.runId,
      seq: machineStageRuns.seq,
      stageId: machineStageRuns.stageId,
      startedAt: machineStageRuns.startedAt,
      machineName: machineRuns.machineName,
      definition: machineRuns.definition,
      prompt: machineRuns.prompt,
      projectId: machineRuns.projectId,
    })
    .from(machineStageRuns)
    .innerJoin(machineRuns, eq(machineRuns.id, machineStageRuns.runId))
    .where(
      and(
        eq(machineStageRuns.kind, "human"),
        eq(machineStageRuns.status, "waiting"),
        eq(machineRuns.status, "waiting"),
      ),
    )
    .all()
    .map((g) => ({ ...g, token: `${g.runId}:${g.seq}` }));
}
