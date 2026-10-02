import { count, countDistinct, desc, eq, inArray, max } from "drizzle-orm";
import type { Db } from "./index";
import { getConversation } from "./chat";
import { getLeaseByOwner, listCallsForConversation } from "./sandboxes";
import {
  conversations,
  machineRuns,
  projects,
  sandboxAttachments,
  sandboxCalls,
  sandboxes,
} from "./schema";

/**
 * 0011 phase 2: the chat's read-model of its sandboxes — what each
 * sandboxed tool call ran in, and where the NEXT one would run. Pure
 * reads over sandbox_calls / sandboxes / conversations; no invariants
 * live here (those are db/sandboxes.ts).
 */

export interface SandboxRef {
  id: string;
  status: string;
  /** Human label for the owner: a chat title or machine run name. */
  ownerLabel: string;
  ownerKind: string;
  ownerId: string;
  /** True when this conversation owns it (vs. joined someone else's). */
  own: boolean;
}

export interface CallSandbox {
  sandboxId: string;
  via: "dedicated" | "attached";
  /** The previous sandboxed call in this chat used a different sandbox. */
  changed: boolean;
}

/** Where the conversation's next sandboxed call would run. */
export type SandboxState =
  | { kind: "none" }
  /** No sandbox exists yet; one is created on first use. */
  | { kind: "pending" }
  /** Plain chat with no project and no attach: nothing to run in. */
  | { kind: "unavailable" }
  | { kind: "own"; sandboxId: string }
  | { kind: "attached"; sandboxId: string };

export interface ConversationSandboxView {
  state: SandboxState;
  /** toolCallId → the sandbox that call ran in. */
  calls: Record<string, CallSandbox>;
  /** Every sandbox referenced by `calls` or `state`, by id. */
  sandboxes: Record<string, SandboxRef>;
}

function ownerLabel(db: Db, ownerKind: string, ownerId: string): string {
  if (ownerKind === "machine_run") {
    const run = db
      .select({ name: machineRuns.machineName })
      .from(machineRuns)
      .where(eq(machineRuns.id, ownerId))
      .get();
    return run ? `${run.name} run` : ownerId;
  }
  const convo = db
    .select({ title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, ownerId))
    .get();
  return convo?.title ?? ownerId;
}

export function loadConversationSandboxView(
  db: Db,
  conversationId: string,
): ConversationSandboxView {
  const conversation = getConversation(db, conversationId);
  const calls = listCallsForConversation(db, conversationId);

  const callMap: Record<string, CallSandbox> = {};
  let previous: string | null = null;
  for (const call of calls) {
    callMap[call.toolCallId] = {
      sandboxId: call.sandboxId,
      via: call.via,
      changed: previous !== null && previous !== call.sandboxId,
    };
    previous = call.sandboxId;
  }

  const pref = conversation?.sandboxPref ?? null;
  let state: SandboxState;
  if (pref === "none") {
    state = { kind: "none" };
  } else if (pref?.startsWith("attached:")) {
    state = { kind: "attached", sandboxId: pref.slice("attached:".length) };
  } else {
    const own = getLeaseByOwner(db, "conversation", conversationId);
    state = own
      ? { kind: "own", sandboxId: own.id }
      : conversation?.projectId
        ? { kind: "pending" }
        : { kind: "unavailable" };
  }

  const ids = new Set(Object.values(callMap).map((c) => c.sandboxId));
  if (state.kind === "own" || state.kind === "attached") ids.add(state.sandboxId);

  const refs: Record<string, SandboxRef> = {};
  if (ids.size > 0) {
    const rows = db
      .select()
      .from(sandboxes)
      .where(inArray(sandboxes.id, [...ids]))
      .all();
    for (const row of rows) {
      refs[row.id] = {
        id: row.id,
        status: row.status,
        ownerKind: row.ownerKind,
        ownerId: row.ownerId,
        ownerLabel: ownerLabel(db, row.ownerKind, row.ownerId),
        own: row.ownerKind === "conversation" && row.ownerId === conversationId,
      };
    }
  }

  return { state, calls: callMap, sandboxes: refs };
}

// ── /sandboxes (0011 phase 3) ────────────────────────────────────────────

export interface SandboxSummary {
  id: string;
  status: string;
  provider: string;
  ref: string;
  ownerKind: string;
  ownerId: string;
  ownerLabel: string;
  /** Where the owner lives in the app (its chat or run page). */
  ownerHref: string;
  projectId: string | null;
  projectName: string | null;
  createdAt: number;
  lastUsedAt: number;
  destroyedAt: number | null;
  /** Recorded sandboxed tool calls that ran here. */
  calls: number;
  /** Distinct chats that ran calls here or are attached to it. */
  chats: number;
}

export interface SandboxUser {
  conversationId: string;
  title: string | null;
  /** Owner (own dedicated sandbox) vs. joined someone else's. */
  owner: boolean;
  calls: number;
  lastAt: number | null;
}

export interface SandboxCallEntry {
  toolCallId: string;
  tool: string;
  via: string;
  conversationId: string;
  conversationTitle: string | null;
  at: number;
}

export interface SandboxDetail extends SandboxSummary {
  users: SandboxUser[];
  /** Newest first, capped. */
  recentCalls: SandboxCallEntry[];
}

const RECENT_CALLS = 50;

function ownerHref(ownerKind: string, ownerId: string): string {
  return ownerKind === "machine_run" ? `/r/${ownerId}` : `/c/${ownerId}`;
}

function summarize(db: Db, rows: (typeof sandboxes.$inferSelect)[]): SandboxSummary[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const callStats = new Map(
    db
      .select({
        sandboxId: sandboxCalls.sandboxId,
        calls: count(),
        chats: countDistinct(sandboxCalls.conversationId),
      })
      .from(sandboxCalls)
      .where(inArray(sandboxCalls.sandboxId, ids))
      .groupBy(sandboxCalls.sandboxId)
      .all()
      .map((r) => [r.sandboxId, r]),
  );
  // Attached chats that have not (yet) run a call still use the sandbox.
  const attached = db
    .select({
      sandboxId: sandboxAttachments.sandboxId,
      conversationId: sandboxAttachments.conversationId,
    })
    .from(sandboxAttachments)
    .where(inArray(sandboxAttachments.sandboxId, ids))
    .all();
  const calledBy = new Map<string, Set<string>>();
  for (const r of db
    .select({ s: sandboxCalls.sandboxId, c: sandboxCalls.conversationId })
    .from(sandboxCalls)
    .where(inArray(sandboxCalls.sandboxId, ids))
    .groupBy(sandboxCalls.sandboxId, sandboxCalls.conversationId)
    .all()) {
    (calledBy.get(r.s) ?? calledBy.set(r.s, new Set()).get(r.s)!).add(r.c);
  }
  const extraChats = new Map<string, number>();
  for (const a of attached) {
    if (!calledBy.get(a.sandboxId)?.has(a.conversationId)) {
      extraChats.set(a.sandboxId, (extraChats.get(a.sandboxId) ?? 0) + 1);
    }
  }

  const projectIds = [...new Set(rows.flatMap((r) => (r.projectId ? [r.projectId] : [])))];
  const projectNames = new Map(
    projectIds.length === 0
      ? []
      : db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, projectIds))
          .all()
          .map((p) => [p.id, p.name]),
  );

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    provider: row.provider,
    ref: row.ref,
    ownerKind: row.ownerKind,
    ownerId: row.ownerId,
    ownerLabel: ownerLabel(db, row.ownerKind, row.ownerId),
    ownerHref: ownerHref(row.ownerKind, row.ownerId),
    projectId: row.projectId,
    projectName: row.projectId ? (projectNames.get(row.projectId) ?? row.projectId) : null,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    destroyedAt: row.destroyedAt,
    calls: callStats.get(row.id)?.calls ?? 0,
    chats: (callStats.get(row.id)?.chats ?? 0) + (extraChats.get(row.id) ?? 0),
  }));
}

/** Every sandbox, live ones first (most recently used), then destroyed. */
export function listSandboxSummaries(db: Db): SandboxSummary[] {
  const rows = db.select().from(sandboxes).orderBy(desc(sandboxes.lastUsedAt)).all();
  const summaries = summarize(db, rows);
  return [
    ...summaries.filter((s) => s.status !== "destroyed"),
    ...summaries.filter((s) => s.status === "destroyed"),
  ];
}

export function getSandboxDetail(db: Db, id: string): SandboxDetail | null {
  const row = db.select().from(sandboxes).where(eq(sandboxes.id, id)).get();
  if (!row) return null;
  const [summary] = summarize(db, [row]);

  const perChat = db
    .select({
      conversationId: sandboxCalls.conversationId,
      calls: count(),
      lastAt: max(sandboxCalls.at),
    })
    .from(sandboxCalls)
    .where(eq(sandboxCalls.sandboxId, id))
    .groupBy(sandboxCalls.conversationId)
    .all();
  const attached = db
    .select({ conversationId: sandboxAttachments.conversationId })
    .from(sandboxAttachments)
    .where(eq(sandboxAttachments.sandboxId, id))
    .all();

  const chatIds = new Set([
    ...perChat.map((c) => c.conversationId),
    ...attached.map((a) => a.conversationId),
  ]);
  const titles = new Map(
    chatIds.size === 0
      ? []
      : db
          .select({ id: conversations.id, title: conversations.title })
          .from(conversations)
          .where(inArray(conversations.id, [...chatIds]))
          .all()
          .map((c) => [c.id, c.title]),
  );

  const stats = new Map(perChat.map((c) => [c.conversationId, c]));
  const users: SandboxUser[] = [...chatIds].map((conversationId) => ({
    conversationId,
    title: titles.get(conversationId) ?? null,
    owner: row.ownerKind === "conversation" && row.ownerId === conversationId,
    calls: stats.get(conversationId)?.calls ?? 0,
    lastAt: stats.get(conversationId)?.lastAt ?? null,
  }));
  users.sort((a, b) => Number(b.owner) - Number(a.owner) || (b.lastAt ?? 0) - (a.lastAt ?? 0));

  const recentCalls = db
    .select()
    .from(sandboxCalls)
    .where(eq(sandboxCalls.sandboxId, id))
    .orderBy(desc(sandboxCalls.at))
    .limit(RECENT_CALLS)
    .all()
    .map((c) => ({
      toolCallId: c.toolCallId,
      tool: c.tool,
      via: c.via,
      conversationId: c.conversationId,
      conversationTitle: titles.get(c.conversationId) ?? null,
      at: c.at,
    }));

  return { ...summary!, users, recentCalls };
}
