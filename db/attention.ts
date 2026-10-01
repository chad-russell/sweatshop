import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./index";
import { OrganizeError, folderPath } from "./organize";
import {
  conversationEvents,
  conversations,
  folders,
  messages,
  projects,
  ticketRuns,
} from "./schema";

/**
 * 0008 attention: what is waiting on the user.
 *
 *  - **Unread** — a conversation with an assistant message newer than
 *    `conversations.last_seen_at`. Opening a conversation (while the tab
 *    is visible and focused) marks it seen; it can be marked unread again.
 *  - **Needs you** — a pending human-input request (tool approval,
 *    question, session limit) or a ticket run parked at its plan gate.
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
  return out;
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
  /** Pending ticket-run plan gates. */
  ticketGates: number;
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
  const ticketGates =
    db
      .select({ n: sql<number>`count(*)` })
      .from(ticketRuns)
      .where(eq(ticketRuns.status, "awaiting-approval"))
      .get()?.n ?? 0;
  return { unread, needsYou, ticketGates };
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

export interface NeedsYouTicket {
  kind: "ticket";
  id: string;
  projectId: string;
  projectName: string | null;
  ticket: string;
  /** The plan awaiting approval. */
  plan: string | null;
  branch: string | null;
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
  needsYou: (NeedsYouThread | NeedsYouTicket)[];
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

  const gates: NeedsYouTicket[] = db
    .select()
    .from(ticketRuns)
    .where(eq(ticketRuns.status, "awaiting-approval"))
    .all()
    .map((t) => ({
      kind: "ticket",
      id: t.id,
      projectId: t.projectId,
      projectName: projectName.get(t.projectId) ?? t.projectId,
      ticket: t.ticket,
      plan: t.detail,
      branch: t.branch,
      since: t.updatedAt,
    }));

  const needsYou = [...threads, ...gates].sort((a, b) => a.since - b.since);

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
