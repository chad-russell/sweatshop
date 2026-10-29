import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "./index";
import { OrganizeError, folderPath } from "./organize";
import {
  conversations,
  folders,
  messages,
  pendingInputs,
  previews,
  projectRepos,
  projects,
} from "./schema";
import { conversationLabel, placeholderToolNames, stripToolPlaceholders } from "../lib/conversation-label";
import { isOutlineCard } from "./outlines";
import { isAskOwnerCard } from "../lib/question-form";
import type {
  AttentionState,
  InboxData,
  NeedsYouPreview,
  NeedsYouThread,
  PendingRequest,
  UnreadThread,
  Where,
} from "../lib/read-models/attention";
import type { PromptChangeCard } from "../lib/read-models/attention";

// 0049: the view shapes moved to @/lib/read-models/attention; re-exported
// here so server-side importers keep one door into the store layer.
export type {
  AttentionState,
  InboxData,
  NeedsYouPreview,
  NeedsYouThread,
  PendingRequest,
  RequestOption,
  UnreadThread,
  Where,
} from "../lib/read-models/attention";

/**
 * 0008 attention: what is waiting on the user.
 *
 *  - **Unread** — a conversation with an assistant message newer than
 *    `conversations.last_seen_at`. Opening a conversation (while the tab
 *    is visible and focused) marks it seen; it can be marked unread again.
 *  - **Needs you** — a pending human-input request (tool approval or
 *    question, from unresolved `pending_inputs` rows — 0010). Opening
 *    the thread does NOT clear it; only answering does. (Machine-run
 *    gates were also here; 0037 phase 5 deleted machines, 0048 purged
 *    the runs themselves.)
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

export function isExecCard(value: unknown): value is NonNullable<PendingRequest["exec"]> {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "exec" &&
    typeof v.host === "string" &&
    typeof v.user === "string" &&
    typeof v.address === "string" &&
    typeof v.command === "string" &&
    typeof v.timeoutSec === "number" &&
    (v.description === undefined || typeof v.description === "string")
  );
}

export function isPromptChangeCard(value: unknown): value is PromptChangeCard {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.kind === "prompt_change" && typeof v.title === "string" &&
    typeof v.currentVersion === "number" && !!v.target && typeof v.target === "object" &&
    !!v.patch && typeof v.patch === "object";
}

function parseCard(card: string | null): {
  evidence: PendingRequest["evidence"];
  outline: PendingRequest["outline"];
  exec: PendingRequest["exec"];
  promptChange: PendingRequest["promptChange"];
  askOwner: PendingRequest["askOwner"];
} {
  const empty = { evidence: null, outline: null, exec: null, promptChange: null, askOwner: null };
  if (!card) return empty;
  try {
    const value = JSON.parse(card) as unknown;
    if (isOutlineCard(value)) return { ...empty, outline: value };
    if (isExecCard(value)) return { ...empty, exec: value };
    if (isPromptChangeCard(value)) return { ...empty, promptChange: value };
    if (isAskOwnerCard(value)) return { ...empty, askOwner: value };
    return { ...empty, evidence: value as PendingRequest["evidence"] };
  } catch {
    return empty;
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
            isNull(pendingInputs.resolvedAt), ne(pendingInputs.kind, "plan"),
            inArray(pendingInputs.conversationId, [...onlyIds]),
          )
        : and(isNull(pendingInputs.resolvedAt), ne(pendingInputs.kind, "plan")),
    )
    .all();

  const out = new Map<string, PendingRequest[]>();
  for (const row of rows) {
    const list = out.get(row.conversationId) ?? [];
    // kind "question" renders the freeform question card; anything else
    // is an approval with Approve/Deny.
    const isQuestion = row.kind === "question";
    const isOutline = row.kind === "outline";
    const card = parseCard(row.card);
    list.push({
      requestId: row.id,
      kind: isOutline ? "outline" : isQuestion ? "question" : "tool-approval",
      prompt: row.question,
      options: isQuestion || isOutline
        ? []
        : [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "deny", label: "Deny", style: "danger" },
          ],
      allowFreeform: true,
      toolName: isOutline
          ? "update_outline"
          : card.outline
              ? "accept_outline"
              : card.exec
                ? "exec"
                : card.promptChange
                  ? card.promptChange.target.kind === "skill"
                    ? "save_skill"
                    : "propose_prompt_change"
                  : "ask_owner",
      // 0043: an exec ask renders its own block — no generic JSON dump.
      toolInput: isOutline || card.outline || card.exec || card.promptChange
        ? null
        : { kind: row.kind, question: row.question },
      evidence: card.evidence,
      outline: card.outline,
      exec: card.exec,
      promptChange: card.promptChange,
      askOwner: card.askOwner,
      at: row.createdAt,
    });
    out.set(row.conversationId, list);
  }
  return out;
}

/**
 * Newest unread-worthy activity per conversation: the latest assistant
 * message. `id` narrows the scan to one conversation (markSeen /
 * markUnread).
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
  return new Map(assistant.map((r): [string, number] => [r.conversationId, r.at]));
}

export function loadAttention(db: Conn): AttentionState {
  const latest = latestActivityAt(db);
  const rows = db
    .select({
      id: conversations.id,
      lastSeenAt: conversations.lastSeenAt,
      archivedAt: conversations.archivedAt,
      trashedAt: conversations.trashedAt,
      activeRunId: conversations.activeRunId,
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
  // Live turns belong in the signature: a run starting or ending must refresh
  // the sidebar so its spinner appears and clears without a manual reload.
  const liveRuns = [...live.values()].filter((r) => r.activeRunId).map((r) => `${r.id}:${r.activeRunId}`);
  const signature = [
    [...unread].sort().join(","),
    requestIds.sort().join(","),
    previewFailures.sort().join(","),
    liveRuns.sort().join(","),
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

const SNIPPET_MAX = 600;
const SNIPPET_SCAN_ROWS = 25;

/** Clip markdown to ~SNIPPET_MAX at a paragraph/line/word boundary,
 *  keeping newlines (only runs of 3+ newlines and trailing spaces collapse). */
export function clipMarkdown(text: string, max = SNIPPET_MAX): string {
  const tidy = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (tidy.length <= max) return tidy;
  const head = tidy.slice(0, max);
  const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "));
  return `${(cut > max * 0.6 ? head.slice(0, cut) : head).trimEnd()}…`;
}

/** Snippet source: newest assistant row with real text, else an activity
 *  line from the newest row's tool placeholders. */
function unreadSnippet(db: Conn, id: string): { snippet: string; at: number } | null {
  const rows = db
    .select({ text: messages.text, at: messages.at })
    .from(messages)
    .where(and(eq(messages.conversationId, id), eq(messages.role, "assistant")))
    .orderBy(sql`${messages.at} desc, rowid desc`)
    .limit(SNIPPET_SCAN_ROWS)
    .all();
  const newest = rows[0];
  if (!newest) return null;
  for (const row of rows) {
    const real = stripToolPlaceholders(row.text);
    if (real) return { snippet: clipMarkdown(real), at: newest.at };
  }
  const names = placeholderToolNames(newest.text);
  const snippet = names.length ? `Ran ${names.map((n) => `\`${n}\``).join(", ")}` : "Working…";
  return { snippet, at: newest.at };
}

function firstUserText(db: Conn, id: string): string | null {
  return (
    db
      .select({ text: messages.text })
      .from(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.role, "user")))
      .orderBy(sql`rowid asc`)
      .limit(1)
      .get()?.text ?? null
  );
}

const labelFor = (db: Conn, id: string, title: string | null | undefined) =>
  conversationLabel({ title, id, firstUserText: title?.trim() ? null : firstUserText(db, id) });

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
      label: labelFor(db, id, meta.get(id)?.title),
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
    const last = unreadSnippet(db, id);
    if (!last) return [];
    return [
      {
        id,
        kind: "chat",
        title: meta.get(id)?.title ?? null,
        label: labelFor(db, id, meta.get(id)?.title),
        snippet: last.snippet,
        at: last.at,
        ...where(id),
      },
    ];
  });
  unread.sort((a, b) => b.at - a.at);

  return { needsYou, unread };
}
