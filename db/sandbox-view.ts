import { and, countDistinct, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "./index";
import { getConversationBinding } from "./sandboxes";
import {
  conversations,
  machineRuns,
  previews,
  projects,
  sandboxes,
} from "./schema";

/**
 * The chat's read-model of its sandboxes (0011 → 0031): the
 * conversation's BINDING is the record — where sandboxed calls ran and
 * where the next one will. Pure reads over conversations / sandboxes;
 * no invariants live here (those are db/sandboxes.ts).
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

/** Where the conversation's sandboxed calls run (0013: its binding). */
export type SandboxState =
  | { kind: "none" }
  /** No sandbox exists yet; one is created on first use. */
  | { kind: "pending" }
  /** Plain chat with no project and no attach: nothing to run in. */
  | { kind: "unavailable" }
  | { kind: "own"; sandboxId: string; workDir: string }
  | { kind: "attached"; sandboxId: string; workDir: string };

export interface ConversationSandboxView {
  state: SandboxState;
  /** Every sandbox the state references, by id. */
  sandboxes: Record<string, SandboxRef>;
}

function ownerLabel(db: Db, ownerKind: string, ownerId: string): string {
  // 0016: a branch preview's sandbox is owned by the preview (id = owner).
  if (ownerKind === "preview") {
    const p = db.select({ label: previews.label, branch: previews.branch }).from(previews).where(eq(previews.id, ownerId)).get();
    return p ? `${p.label ?? p.branch ?? ownerId} preview` : ownerId;
  }
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
  const binding = getConversationBinding(db, conversationId);

  // 0013: the state IS the binding (fixed once bound).
  const state: SandboxState =
    !binding || binding.kind === "none"
      ? binding?.disabled
        ? { kind: "none" }
        : { kind: "unavailable" }
      : binding.kind === "pending"
        ? { kind: "pending" }
        : binding.owner
          ? { kind: "own", sandboxId: binding.sandboxId, workDir: binding.workDir }
          : { kind: "attached", sandboxId: binding.sandboxId, workDir: binding.workDir };

  const ids = new Set(state.kind === "own" || state.kind === "attached" ? [state.sandboxId] : []);

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

  return { state, sandboxes: refs };
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
  /** Distinct chats bound to it (owning or attached). */
  chats: number;
}

export interface SandboxUser {
  conversationId: string;
  title: string | null;
  /** Owner (own dedicated sandbox) vs. joined someone else's. */
  owner: boolean;
  lastAt: number | null;
}

export interface SandboxDetail extends SandboxSummary {
  users: SandboxUser[];
}

function ownerHref(ownerKind: string, ownerId: string): string {
  if (ownerKind === "preview") return `/previews?id=${ownerId}`;
  return ownerKind === "machine_run" ? `/r/${ownerId}` : `/c/${ownerId}`;
}

/** Chats bound to each sandbox: `conversations.sandbox_id` (0031: the
 *  binding is the record — owner and attached both set the column). */
function boundChats(db: Db, ids: string[]): Map<string, { conversationId: string; lastAt: number }[]> {
  const map = new Map<string, { conversationId: string; lastAt: number }[]>();
  if (ids.length === 0) return map;
  const rows = db
    .select({
      sandboxId: conversations.sandboxId,
      conversationId: conversations.id,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(inArray(conversations.sandboxId, ids))
    .all();
  for (const row of rows) {
    const list = map.get(row.sandboxId!) ?? map.set(row.sandboxId!, []).get(row.sandboxId!)!;
    list.push({ conversationId: row.conversationId, lastAt: row.updatedAt });
  }
  return map;
}

function summarize(db: Db, rows: (typeof sandboxes.$inferSelect)[]): SandboxSummary[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const chats = boundChats(db, ids);
  const distinct = new Map<string, Set<string>>();
  for (const [sandboxId, list] of chats) {
    distinct.set(sandboxId, new Set(list.map((c) => c.conversationId)));
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
    chats: distinct.get(row.id)?.size ?? 0,
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

  const titles = new Map(
    db
      .select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt })
      .from(conversations)
      .where(and(eq(conversations.sandboxId, id), ne(conversations.kind, "run")))
      .all()
      .map((c) => [c.id, c]),
  );

  const users: SandboxUser[] = [...titles.values()].map((c) => ({
    conversationId: c.id,
    title: c.title,
    owner: row.ownerKind === "conversation" && row.ownerId === c.id,
    lastAt: c.updatedAt,
  }));
  users.sort((a, b) => Number(b.owner) - Number(a.owner) || (b.lastAt ?? 0) - (a.lastAt ?? 0));

  return { ...summary!, users };
}

// ── Which sandbox does this session / run live in? ───────────────────────

export interface SandboxLink {
  id: string;
  status: string;
  /** Short note for the UI: how this thing relates to the sandbox. */
  note: string;
}

function linkFor(db: Db, id: string, note: string): SandboxLink | null {
  const row = db
    .select({ id: sandboxes.id, status: sandboxes.status })
    .from(sandboxes)
    .where(eq(sandboxes.id, id))
    .get();
  return row ? { id: row.id, status: row.status, note } : null;
}

/** A machine run's one sandbox (live, or the most recent if destroyed). */
export function sandboxForMachineRun(db: Db, runId: string): SandboxLink | null {
  const row = db
    .select({ id: sandboxes.id })
    .from(sandboxes)
    .where(and(eq(sandboxes.ownerKind, "machine_run"), eq(sandboxes.ownerId, runId)))
    .orderBy(desc(sandboxes.createdAt))
    .limit(1)
    .get();
  return row ? linkFor(db, row.id, "run sandbox") : null;
}

/**
 * The sandbox behind a harness session page. 0031: the binding answers
 * it — a session id is either a conversation id (chat or stage visit,
 * with a stored binding or its run's) or a machine run id.
 */
export function sandboxForHarnessSession(db: Db, sessionId: string): SandboxLink | null {
  const run = sessionId.match(/^(mr_.+)_\d+$/);
  if (run) return sandboxForMachineRun(db, run[1]!);
  const binding = getConversationBinding(db, sessionId);
  if (binding?.kind === "bound") {
    return linkFor(db, binding.sandboxId, binding.owner ? "own sandbox" : "attached sandbox");
  }
  if (binding) {
    // a run conversation (kind "run"): its machine_runs binding
    return sandboxForMachineRun(db, sessionId);
  }
  return null;
}
