import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "./index";
import { OrganizeError, folderPath } from "./organize";
import {
  conversations,
  folders,
  machineRuns,
  machineStageRuns,
  messages,
  pendingInputs,
  previews,
  projectRepos,
  projects,
} from "./schema";
import { isPlanCard } from "./plans";

/**
 * 0008 attention: what is waiting on the user.
 *
 *  - **Unread** — a conversation with an assistant message newer than
 *    `conversations.last_seen_at`. Opening a conversation (while the tab
 *    is visible and focused) marks it seen; it can be marked unread again.
 *    0012: a run conversation's "output" is the moment it settled
 *    (`machine_runs.settled_at`); `stage` conversations never count —
 *    their output surfaces through the run.
 *  - **Needs you** — a pending human-input request (tool approval or
 *    question, from unresolved `pending_inputs` rows — 0010). Opening
 *    the thread does NOT clear it; only answering does. (Machine-run
 *    gates were also here; 0037 phase 5 deleted machines.)
 */

type Conn = Pick<Db, "select" | "insert" | "update" | "delete">;

/**
 * 0016: branch previews the follower parked as failed and Chad has not
 * dismissed at that sha. (db/previews.listFailedPreviews needs a full Db;
 * this is the same rule on the Conn attention uses.)
 */
function failedPreviews(db: Conn) {
  return db
    .select()
    .from(previews)
    .where(and(isNull(previews.deletedAt), eq(previews.source, "branch"), eq(previews.status, "failed"), isNotNull(previews.failedSha)))
    .all()
    .filter((p) => p.failedSha !== p.dismissedSha);
}

export interface RequestOption {
  id: string;
  label: string;
  description?: string;
  style?: "danger" | "default" | "primary";
}

export interface PendingRequest {
  requestId: string;
  /** 0041: "plan" = a plan in review (hookless — the card approves it). */
  kind: "tool-approval" | "question" | "plan";
  prompt: string;
  options: RequestOption[];
  allowFreeform: boolean;
  /** The tool call behind the request (approvals), when present. */
  toolName: string | null;
  toolInput: Record<string, unknown> | null;
  /** 0037: runtime-built evidence (check result, screenshots) for gated
   *  tools; null for plain asks. */
  evidence: import("../lib/agent/tools/evidence").ApprovalEvidence | null;
  /** 0041: the plan snapshot (plan reviews and accept_plan approvals). */
  plan: import("./plans").PlanCard | null;
  /** Unix ms the request was raised. */
  at: number;
}

function parseCard(card: string | null): { evidence: PendingRequest["evidence"]; plan: PendingRequest["plan"] } {
  if (!card) return { evidence: null, plan: null };
  try {
    const value = JSON.parse(card) as unknown;
    return isPlanCard(value) ? { evidence: null, plan: value } : { evidence: value as PendingRequest["evidence"], plan: null };
  } catch {
    return { evidence: null, plan: null };
  }
}

/**
 * Pending requests per conversation (only conversations with any):
 * unresolved `pending_inputs` rows (ask_chad), answered on
 * `/api/x/input` — the single source since 0032 retired the eve fold.
 */
export function loadPendingRequests(
  db: Conn,
  onlyIds?: readonly string[],
): Map<string, PendingRequest[]> {
  const rows = db
    .select({
      id: pendingInputs.id,
      conversationId: pendingInputs.conversationId,
      kind: pendingInputs.kind,
      question: pendingInputs.question,
      card: pendingInputs.card,
      createdAt: pendingInputs.createdAt,
    })
    .from(pendingInputs)
    .where(
      onlyIds
        ? and(
            isNull(pendingInputs.resolvedAt),
            inArray(pendingInputs.conversationId, [...onlyIds]),
          )
        : isNull(pendingInputs.resolvedAt),
    )
    .all();

  const out = new Map<string, PendingRequest[]>();
  for (const row of rows) {
    const list = out.get(row.conversationId) ?? [];
    // kind "question" renders the freeform question card; anything else
    // is an approval with Approve/Deny.
    const isQuestion = row.kind === "question";
    const isPlan = row.kind === "plan";
    const card = parseCard(row.card);
    list.push({
      requestId: row.id,
      kind: isPlan ? "plan" : isQuestion ? "question" : "tool-approval",
      prompt: row.question,
      options: isQuestion || isPlan
        ? []
        : [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "deny", label: "Deny", style: "danger" },
          ],
      allowFreeform: true,
      toolName: isPlan ? "present_plan" : card.plan ? "accept_plan" : "ask_chad",
      toolInput: isPlan || card.plan ? null : { kind: row.kind, question: row.question },
      evidence: card.evidence,
      plan: card.plan,
      at: row.createdAt,
    });
    out.set(row.conversationId, list);
  }
  return out;
}

/**
 * Newest unread-worthy activity per conversation: the latest assistant
 * message for chats, the settle time for runs (0012). `id` narrows the
 * scan to one conversation (markSeen / markUnread).
 */
function latestActivityAt(db: Conn, id?: string): Map<string, number> {
  const assistant = db
    .select({
      conversationId: messages.conversationId,
      at: sql<number>`max(${messages.at})`,
    })
    .from(messages)
    .where(
      id === undefined
        ? eq(messages.role, "assistant")
        : and(eq(messages.role, "assistant"), eq(messages.conversationId, id)),
    )
    .groupBy(messages.conversationId)
    .all();
  const settled = db
    .select({ id: machineRuns.id, at: machineRuns.settledAt })
    .from(machineRuns)
    .where(id === undefined ? isNotNull(machineRuns.settledAt) : and(isNotNull(machineRuns.settledAt), eq(machineRuns.id, id)))
    .all();
  return new Map([
    ...assistant.map((r): [string, number] => [r.conversationId, r.at]),
    ...settled.map((r): [string, number] => [r.id, r.at!]),
  ]);
}

export interface AttentionState {
  /** Live (not archived/trashed) conversations with unread assistant output. */
  unread: Set<string>;
  /** Conversations with ≥1 pending request (archived ones included —
   *  an approval blocks work whether or not the thread is filed away). */
  needsYou: Set<string>;
  /**
   * Changes iff anything the sidebar dots or the Inbox page show changed
   * (unread set, pending request ids, machine gates). Clients poll it
   * cheaply and refresh only on a difference.
   */
  signature: string;
}

export function loadAttention(db: Conn): AttentionState {
  const latest = latestActivityAt(db);
  const rows = db
    .select({
      id: conversations.id,
      lastSeenAt: conversations.lastSeenAt,
      archivedAt: conversations.archivedAt,
      trashedAt: conversations.trashedAt,
    })
    .from(conversations)
    .where(ne(conversations.kind, "stage"))
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
  const requestIds = [...pending.entries()]
    .filter(([id]) => live.has(id))
    .flatMap(([, list]) => list.map((r) => r.requestId));
  const previewFailures = failedPreviews(db).map((p) => `${p.id}:${p.failedSha}`);
  const signature = [
    [...unread].sort().join(","),
    requestIds.sort().join(","),
    previewFailures.sort().join(","),
  ].join("|");
  return { unread, needsYou, signature };
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
  const latest = latestActivityAt(db, id).get(id);
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
  const latest = latestActivityAt(db, id).get(id);
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

/** 0016: a branch preview the follower parked as failed (one per failing sha). */
export interface NeedsYouPreview {
  kind: "preview";
  /** `<previewId>:<failedSha>` — stable card key. */
  id: string;
  previewId: string;
  label: string;
  branch: string;
  sha: string;
  error: string;
  sandboxId: string;
  projectName: string | null;
  since: number;
}

export interface UnreadThread extends Where {
  id: string;
  /** 0012: "run" threads open /r/<id>. */
  kind: "chat" | "run";
  title: string | null;
  /** Newest assistant message, clipped. */
  snippet: string;
  /** Unix ms of that message. */
  at: number;
}

export interface InboxData {
  needsYou: (NeedsYouThread | NeedsYouPreview)[];
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
      kind: conversations.kind,
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
  const threadIds = [...attention.needsYou].filter((id) => pending.has(id));
  const threads: NeedsYouThread[] = threadIds.map((id) => {
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

  const previewItems: NeedsYouPreview[] = failedPreviews(db).map((p) => {
    const repo = p.repoId
      ? db.select({ projectId: projectRepos.projectId }).from(projectRepos).where(eq(projectRepos.id, p.repoId)).get()
      : undefined;
    return {
      kind: "preview",
      id: `${p.id}:${p.failedSha}`,
      previewId: p.id,
      label: p.label ?? p.branch ?? p.slug,
      branch: p.branch ?? "",
      sha: p.failedSha ?? "",
      error: p.error ?? "",
      sandboxId: p.sandboxId,
      projectName: repo?.projectId ? (projectName.get(repo.projectId) ?? repo.projectId) : null,
      since: p.updatedAt,
    };
  });

  const needsYou = [...threads, ...previewItems].sort((a, b) => a.since - b.since);

  // A thread that needs an answer is shown once, above; Unread is the rest.
  const unreadIds = [...attention.unread].filter((id) => !attention.needsYou.has(id));
  const unread: UnreadThread[] = unreadIds.flatMap((id): UnreadThread[] => {
    if (meta.get(id)?.kind === "run") {
      const run = runUnread(db, id);
      return run ? [{ id, kind: "run", title: meta.get(id)?.title ?? null, ...run, ...where(id) }] : [];
    }
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
        kind: "chat",
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

/** An unread run's card body: its status plus the newest visit outcome. */
function runUnread(db: Conn, runId: string): { snippet: string; at: number } | null {
  const run = db
    .select({ status: machineRuns.status, error: machineRuns.error, settledAt: machineRuns.settledAt })
    .from(machineRuns)
    .where(eq(machineRuns.id, runId))
    .get();
  if (!run?.settledAt) return null;
  const last = db
    .select({ outcome: machineStageRuns.outcome })
    .from(machineStageRuns)
    .where(and(eq(machineStageRuns.runId, runId), isNotNull(machineStageRuns.outcome)))
    .orderBy(desc(machineStageRuns.seq))
    .limit(1)
    .get();
  const detail = run.error ?? last?.outcome ?? "";
  return { snippet: clip(detail ? `${run.status} — ${detail}` : run.status), at: run.settledAt };
}

