import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { removeAttachmentFilesSync } from "../lib/attachments";
import { deleteConversationAttachments } from "./attachments";
import { hostCommands } from "./schema";
import type { Db } from "./index";
import {
  chatHarnessState,
  conversations,
  folders,
  harnessEvents,
  harnessRuns,
  machineRuns,
  messages,
  pendingInputs,
  sandboxAttachments,
  steerQueue,
} from "./schema";

/**
 * 0007 organization store: folders, filing, rename, archive, trash.
 * Every invariant lives here (the API routes and UI only mirror them):
 *
 * - a conversation's folder belongs to the conversation's project
 *   (null ↔ null for the unbound "Chats" group);
 * - a folder's parent is in the same group, and a folder never moves
 *   into itself or a descendant;
 * - sibling folder names are unique per (project, parent),
 *   case-insensitively.
 */

/** A Db or a transaction handle — the query surface the helpers need. */
type Conn = Pick<Db, "select" | "insert" | "update" | "delete">;

export type OrganizeErrorCode =
  | "not-found"
  | "invalid"
  | "cross-group"
  | "cycle"
  | "duplicate-name";

export class OrganizeError extends Error {
  constructor(
    readonly code: OrganizeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OrganizeError";
  }
}

const NAME_MAX = 80;
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function cleanName(name: unknown): string {
  if (typeof name !== "string") {
    throw new OrganizeError("invalid", "name must be a string");
  }
  const collapsed = name.replace(/\s+/g, " ").trim();
  if (!collapsed) throw new OrganizeError("invalid", "name is required");
  return collapsed.slice(0, NAME_MAX);
}

function getFolder(db: Conn, id: string) {
  const row = db.select().from(folders).where(eq(folders.id, id)).get();
  if (!row) throw new OrganizeError("not-found", `folder ${id} not found`);
  return row;
}

function getConversation(db: Conn, id: string) {
  const row = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  if (!row) throw new OrganizeError("not-found", `conversation ${id} not found`);
  return row;
}

function assertNameFree(
  db: Conn,
  projectId: string | null,
  parentId: string | null,
  name: string,
  exceptId?: string,
) {
  const siblings = db
    .select({ id: folders.id, name: folders.name })
    .from(folders)
    .where(
      and(
        projectId === null
          ? isNull(folders.projectId)
          : eq(folders.projectId, projectId),
        parentId === null
          ? isNull(folders.parentId)
          : eq(folders.parentId, parentId),
      ),
    )
    .all();
  const lower = name.toLowerCase();
  if (siblings.some((s) => s.id !== exceptId && s.name.toLowerCase() === lower)) {
    throw new OrganizeError(
      "duplicate-name",
      `a folder named "${name}" already exists here`,
    );
  }
}

/** All folder ids at or below `rootId` (inclusive). */
export function folderSubtreeIds(db: Conn, rootId: string): string[] {
  const rows = db.select({ id: folders.id, parentId: folders.parentId }).from(folders).all();
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const list = children.get(row.parentId) ?? [];
    list.push(row.id);
    children.set(row.parentId, list);
  }
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    out.push(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

/**
 * 0046 locked thread groups: the topmost ancestor of `id` — `id` itself
 * when it has no parent. A visited set stops a corrupted parent cycle
 * from looping: the walk ends at the node just before the repeat, which
 * is as far "up" as the data honestly goes.
 */
function rootConversationId(db: Conn, id: string): string {
  getConversation(db, id);
  const seen = new Set<string>([id]);
  let cursor = id;
  for (;;) {
    const parentId =
      db
        .select({ parentId: conversations.parentConversationId })
        .from(conversations)
        .where(eq(conversations.id, cursor))
        .get()?.parentId ?? null;
    if (parentId === null || seen.has(parentId)) return cursor;
    seen.add(parentId);
    cursor = parentId;
  }
}

/** 0046: the root AND every descendant conversation id (recursive; a
 *  visited set keeps a corrupted parent cycle from looping). */
function conversationGroupIds(db: Conn, rootId: string): string[] {
  const rows = db
    .select({ id: conversations.id, parentId: conversations.parentConversationId })
    .from(conversations)
    .all();
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const list = children.get(row.parentId) ?? [];
    list.push(row.id);
    children.set(row.parentId, list);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

/** Folder path from the group root down to `folderId` (names, in order). */
export function folderPath(
  rows: ReadonlyMap<string, { name: string; parentId: string | null }>,
  folderId: string | null,
): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor = folderId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const row = rows.get(cursor);
    if (!row) break;
    path.unshift(row.name);
    cursor = row.parentId;
  }
  return path;
}

export function createFolder(
  db: Db,
  input: { projectId: string | null; parentId: string | null; name: string },
) {
  const name = cleanName(input.name);
  return db.transaction((tx) => {
    let projectId = input.projectId;
    if (input.parentId) {
      const parent = getFolder(tx, input.parentId);
      if (parent.projectId !== projectId) {
        throw new OrganizeError(
          "cross-group",
          "a subfolder must belong to its parent's project",
        );
      }
      projectId = parent.projectId;
    }
    assertNameFree(tx, projectId, input.parentId, name);
    const row = {
      id: `fld_${randomUUID()}`,
      projectId,
      parentId: input.parentId,
      name,
      createdAt: Date.now(),
    };
    tx.insert(folders).values(row).run();
    return row;
  });
}

export function renameFolder(db: Db, id: string, rawName: string) {
  const name = cleanName(rawName);
  db.transaction((tx) => {
    const folder = getFolder(tx, id);
    assertNameFree(tx, folder.projectId, folder.parentId, name, id);
    tx.update(folders).set({ name }).where(eq(folders.id, id)).run();
  });
}

/** Re-parent a folder within its group; parentId null = group root. */
export function moveFolder(db: Db, id: string, parentId: string | null) {
  db.transaction((tx) => {
    const folder = getFolder(tx, id);
    if (parentId) {
      const parent = getFolder(tx, parentId);
      if (parent.projectId !== folder.projectId) {
        throw new OrganizeError(
          "cross-group",
          "folders cannot move between projects",
        );
      }
      if (folderSubtreeIds(tx, id).includes(parentId)) {
        throw new OrganizeError(
          "cycle",
          "a folder cannot move into itself or its own subfolder",
        );
      }
    }
    assertNameFree(tx, folder.projectId, parentId, folder.name, id);
    tx.update(folders).set({ parentId }).where(eq(folders.id, id)).run();
  });
}

/**
 * Delete a folder; its subfolders and conversations move up one level
 * (nothing else is deleted). Promoted subfolders that would collide with
 * a sibling name get a numeric suffix rather than failing the delete.
 */
export function deleteFolder(db: Db, id: string) {
  db.transaction((tx) => {
    const folder = getFolder(tx, id);
    const taken = new Set(
      tx
        .select({ name: folders.name })
        .from(folders)
        .where(
          and(
            folder.projectId === null
              ? isNull(folders.projectId)
              : eq(folders.projectId, folder.projectId),
            folder.parentId === null
              ? isNull(folders.parentId)
              : eq(folders.parentId, folder.parentId),
          ),
        )
        .all()
        .map((r) => r.name.toLowerCase()),
    );
    const kids = tx.select().from(folders).where(eq(folders.parentId, id)).all();
    for (const kid of kids) {
      let name = kid.name;
      for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
        name = `${kid.name} (${n})`.slice(0, NAME_MAX + 6);
      }
      taken.add(name.toLowerCase());
      tx.update(folders)
        .set({ parentId: folder.parentId, name })
        .where(eq(folders.id, kid.id))
        .run();
    }
    tx.update(conversations)
      .set({ folderId: folder.parentId })
      .where(eq(conversations.folderId, id))
      .run();
    tx.delete(folders).where(eq(folders.id, id)).run();
  });
}

/** File a conversation into a folder of its own group; null = unfile.
 * 0046 locked thread groups: the dragged id is normalized to its
 * topmost ancestor and the folder lands on the root AND every
 * descendant — dragging a parent or any child moves the family
 * together, so filing can never split a group. */
export function moveConversation(
  db: Db,
  conversationId: string,
  folderId: string | null,
) {
  db.transaction((tx) => {
    const dragged = getConversation(tx, conversationId);
    const rootId = rootConversationId(tx, conversationId);
    const root = rootId === conversationId ? dragged : getConversation(tx, rootId);
    if (folderId) {
      const folder = getFolder(tx, folderId);
      if (folder.projectId !== root.projectId) {
        throw new OrganizeError(
          "cross-group",
          "a conversation can only be filed in its own project's folders",
        );
      }
    }
    // Filing deliberately does not bump updatedAt: that column means
    // "last activity", and sorting must not reshuffle on housekeeping.
    tx.update(conversations)
      .set({ folderId })
      .where(inArray(conversations.id, conversationGroupIds(tx, rootId)))
      .run();
  });
}

/** Manual rename — pins the title against regeneration (0007). */
export function renameConversation(db: Db, id: string, rawTitle: string) {
  const title = cleanName(rawTitle);
  getConversation(db, id);
  db.update(conversations)
    .set({ title, titleSource: "manual" })
    .where(eq(conversations.id, id))
    .run();
}

/** Archive/unarchive — 0046: the stamp cascades to the whole locked
 * group (root + descendants), so a shelf never orphans a child. */
export function setArchived(db: Db, id: string, archived: boolean) {
  db.transaction((tx) => {
    const ids = conversationGroupIds(tx, rootConversationId(tx, id));
    tx.update(conversations)
      .set({ archivedAt: archived ? Date.now() : null })
      .where(inArray(conversations.id, ids))
      .run();
  });
}

/** Trash/untrash — 0046: same group cascade as archiving. */
export function setTrashed(db: Db, id: string, trashed: boolean) {
  db.transaction((tx) => {
    const ids = conversationGroupIds(tx, rootConversationId(tx, id));
    tx.update(conversations)
      .set({ trashedAt: trashed ? Date.now() : null })
      .where(inArray(conversations.id, ids))
      .run();
  });
}

/**
 * Permanently remove a conversation from the sweatshop store: the
 * mirror (events, extracted messages) and harness activity. 0012: a run
 * conversation takes its whole run with it — the machine_runs row (its
 * visits cascade), each visit's session (`<runId>_<seq>`: stage
 * conversations and harness activity) — so purge leaves no orphans.
 * 0046 locked groups: the dragged id's root + every descendant join the
 * purge; a run-kind session anywhere in the group keeps its machine_runs
 * path above.
 *
 * 0013: returns the sandbox ids the purged run OWNED (an inherited one
 * belongs to its owner). The store is synchronous and cannot reach the
 * provider, so the caller destroys them (`destroyOwnedSandboxes`); the
 * sandbox rows stay as destroyed history (0011).
 */
export function deleteConversationForever(db: Db, id: string): string[] {
  const owned: string[] = [];
  const attachmentIds: string[] = [];
  db.transaction((tx) => {
    getConversation(tx, id);
    const sessions = conversationGroupIds(tx, rootConversationId(tx, id));
    const pending = [...sessions];
    while (pending.length > 0) {
      const sid = pending.shift()!;
      const kind = tx
        .select({ kind: conversations.kind })
        .from(conversations)
        .where(eq(conversations.id, sid))
        .get()?.kind;
      if (kind !== "run") continue;
      const run = tx
        .select({ sandboxId: machineRuns.sandboxId, owner: machineRuns.sandboxOwner })
        .from(machineRuns)
        .where(eq(machineRuns.id, sid))
        .get();
      if (run?.sandboxId && run.owner) owned.push(run.sandboxId);
      const visitSessions = sql`glob ${`${sid}_[0-9]*`}`;
      for (const c of tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(sql`${conversations.id} ${visitSessions}`)
        .all()) {
        if (!sessions.includes(c.id)) {
          sessions.push(c.id);
          pending.push(c.id);
        }
      }
      tx.delete(harnessEvents).where(sql`${harnessEvents.sessionId} ${visitSessions}`).run();
      tx.delete(harnessRuns).where(sql`${harnessRuns.sessionId} ${visitSessions}`).run();
      tx.delete(machineRuns).where(eq(machineRuns.id, sid)).run();
    }
    for (const sid of sessions) {
      tx.delete(messages).where(eq(messages.conversationId, sid)).run();
      tx.delete(harnessEvents).where(eq(harnessEvents.sessionId, sid)).run();
      tx.delete(harnessRuns).where(eq(harnessRuns.sessionId, sid)).run();
      // 0011 sandbox records name the conversation (FKs): its
      // attachments go with it; the sandbox rows themselves stay.
      tx.delete(sandboxAttachments).where(eq(sandboxAttachments.conversationId, sid)).run();
      // Everything else that FKs the conversation (found live
      // 2026-10-08: a purged harness chat or an answered approval
      // threw FOREIGN KEY — these were never part of the teardown).
      // 0042: its image rows go (files are removed after the commit).
      attachmentIds.push(...deleteConversationAttachments(tx, sid));
      tx.delete(steerQueue).where(eq(steerQueue.conversationId, sid)).run();
      tx.delete(chatHarnessState).where(eq(chatHarnessState.conversationId, sid)).run();
      tx.delete(pendingInputs).where(eq(pendingInputs.conversationId, sid)).run();
      // 0043: its host-command audit rows go with the conversation.
      tx.delete(hostCommands).where(eq(hostCommands.conversationId, sid)).run();
      tx.delete(conversations).where(eq(conversations.id, sid)).run();
    }
  });
  for (const attId of attachmentIds) removeAttachmentFilesSync(attId);
  return owned;
}

/** Lazy retention sweep: purges expired trash and returns the sandbox
 *  ids the purged runs owned (the caller destroys them). */
export function purgeExpiredTrash(db: Db, now: number = Date.now()): string[] {
  const expired = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        isNotNull(conversations.trashedAt),
        lt(conversations.trashedAt, now - TRASH_RETENTION_MS),
      ),
    )
    .all();
  return expired.flatMap(({ id }) => deleteConversationForever(db, id));
}

// ---------------------------------------------------------------------
// Sidebar read model

export interface SidebarItem {
  id: string;
  title: string | null;
  updatedAt: number;
  /** 0040 phase 2: when it was created — children sort oldest-first by
   *  this (lib/sidebar-tree.ts), independent of updatedAt's recency sort. */
  createdAt: number;
  /** 0012: "chat" | "run" (stage rows never reach the sidebar). */
  kind: string;
  /** 0012: the run's status for run rows; null for chats. */
  runStatus: string | null;
  /** 0037 phase 3 / 0040 phase 2: the `start_thread` parent, when this is
   *  a child — nests it in the sidebar tree (lib/sidebar-tree.ts). Null
   *  for an ordinary chat. */
  parentConversationId: string | null;
  /** 0040 phase 2: a live turn is running right now (any conversation
   *  kind) — rolls up into a collapsed parent's aggregate indicator. */
  activeRunId: string | null;
  /** 0008: assistant output the user has not viewed yet. */
  unread: boolean;
  /** 0008: a pending approval/question is waiting on the user. */
  needsYou: boolean;
}

/** Rolled-up attention counts for a collapsible container. */
export interface AttentionCounts {
  unread: number;
  needsYou: number;
}

export interface FolderNode {
  id: string;
  name: string;
  /** Newest activity in the folder or any descendant; createdAt if empty. */
  activityAt: number;
  folders: FolderNode[];
  items: SidebarItem[];
  /** Conversations at or below this folder. */
  count: number;
  /** Attention at or below this folder (shown while it is collapsed). */
  attention: AttentionCounts;
}

export interface SidebarGroup {
  project: { id: string; name: string } | null;
  folders: FolderNode[];
  /** Conversations not filed in any folder (shown as "Unfiled"). */
  unfiled: SidebarItem[];
  attention: AttentionCounts;
}

/** A conversation outside the main tree (Archive / Trash view) — flat,
 *  no parent/child nesting (0040 phase 2 scopes the tree to the live
 *  library; a breadcrumb already says where an archived/trashed item
 *  came from). */
export interface ShelvedItem
  extends Omit<SidebarItem, "unread" | "needsYou" | "runStatus" | "parentConversationId" | "activeRunId"> {
  projectName: string | null;
  /** Folder breadcrumb, e.g. ["Spikes", "Sandbox"]. */
  path: string[];
  at: number;
}

export interface SidebarData {
  groups: SidebarGroup[];
  archived: ShelvedItem[];
  trashed: ShelvedItem[];
}

const SHELF_LIMIT = 200;

/** Which conversations carry a dot (see db/attention.ts loadAttention). */
export interface AttentionFlags {
  unread: ReadonlySet<string>;
  needsYou: ReadonlySet<string>;
}

const NO_ATTENTION: AttentionFlags = { unread: new Set(), needsYou: new Set() };

function sumAttention(items: readonly SidebarItem[], below: readonly AttentionCounts[]): AttentionCounts {
  return {
    unread: items.filter((i) => i.unread).length + below.reduce((n, a) => n + a.unread, 0),
    needsYou: items.filter((i) => i.needsYou).length + below.reduce((n, a) => n + a.needsYou, 0),
  };
}

export function loadSidebar(db: Db, flags: AttentionFlags = NO_ATTENTION): SidebarData {
  const projectRows = db
    .query.projects.findMany()
    .sync()
    .sort((a, b) => a.name.localeCompare(b.name));
  const folderRows = db.select().from(folders).all();
  const folderIndex = new Map(folderRows.map((f) => [f.id, f]));
  const conversationRows = db
    .select({
      id: conversations.id,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
      createdAt: conversations.createdAt,
      projectId: conversations.projectId,
      folderId: conversations.folderId,
      archivedAt: conversations.archivedAt,
      trashedAt: conversations.trashedAt,
      kind: conversations.kind,
      parentConversationId: conversations.parentConversationId,
      activeRunId: conversations.activeRunId,
    })
    .from(conversations)
    .where(ne(conversations.kind, "stage"))
    .all();
  const runStatus = new Map(
    db.select({ id: machineRuns.id, status: machineRuns.status }).from(machineRuns).all().map((r) => [r.id, r.status]),
  );

  const projectName = new Map(projectRows.map((p) => [p.id, p.name]));
  const shelved = (
    rows: typeof conversationRows,
    pick: (r: (typeof conversationRows)[number]) => number | null,
  ): ShelvedItem[] =>
    rows
      .map((r) => ({
        id: r.id,
        title: r.title,
        updatedAt: r.updatedAt,
        createdAt: r.createdAt,
        kind: r.kind,
        projectName: r.projectId ? (projectName.get(r.projectId) ?? r.projectId) : null,
        path: folderPath(folderIndex, r.folderId),
        at: pick(r) ?? 0,
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, SHELF_LIMIT);

  const live = conversationRows.filter((r) => !r.trashedAt && !r.archivedAt);
  const archived = shelved(
    conversationRows.filter((r) => !r.trashedAt && r.archivedAt),
    (r) => r.archivedAt,
  );
  const trashed = shelved(
    conversationRows.filter((r) => r.trashedAt),
    (r) => r.trashedAt,
  );

  const toItem = (r: (typeof live)[number]): SidebarItem => ({
    id: r.id,
    title: r.title,
    updatedAt: r.updatedAt,
    createdAt: r.createdAt,
    kind: r.kind,
    runStatus: r.kind === "run" ? (runStatus.get(r.id) ?? null) : null,
    parentConversationId: r.parentConversationId,
    activeRunId: r.activeRunId,
    unread: flags.unread.has(r.id),
    needsYou: flags.needsYou.has(r.id),
  });

  const buildGroup = (
    projectId: string | null,
  ): Pick<SidebarGroup, "folders" | "unfiled" | "attention"> => {
    const groupFolders = folderRows.filter((f) => f.projectId === projectId);
    const groupConversations = live.filter((r) => r.projectId === projectId);
    const folderIds = new Set(groupFolders.map((f) => f.id));

    const build = (parentId: string | null): FolderNode[] =>
      groupFolders
        .filter((f) => f.parentId === parentId)
        .map((f) => {
          const subfolders = build(f.id);
          const items = groupConversations
            .filter((r) => r.folderId === f.id)
            .map(toItem)
            .sort((a, b) => b.updatedAt - a.updatedAt);
          const activityAt = Math.max(
            f.createdAt,
            ...items.map((i) => i.updatedAt),
            ...subfolders.map((s) => s.activityAt),
          );
          return {
            id: f.id,
            name: f.name,
            activityAt,
            folders: subfolders,
            items,
            count: items.length + subfolders.reduce((n, s) => n + s.count, 0),
            attention: sumAttention(items, subfolders.map((s) => s.attention)),
          };
        })
        .sort((a, b) => b.activityAt - a.activityAt);

    const tree = build(null);
    // A conversation whose folder vanished (should not happen) still
    // surfaces as unfiled rather than disappearing.
    const unfiled = groupConversations
      .filter((r) => !r.folderId || !folderIds.has(r.folderId))
      .map(toItem)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      folders: tree,
      unfiled,
      attention: sumAttention(unfiled, tree.map((f) => f.attention)),
    };
  };

  const groups: SidebarGroup[] = projectRows.map((p) => ({
    project: { id: p.id, name: p.name },
    ...buildGroup(p.id),
  }));
  const chats = buildGroup(null);
  if (chats.unfiled.length > 0 || chats.folders.length > 0) {
    groups.push({ project: null, ...chats });
  }
  return { groups, archived, trashed };
}

/** Count of conversations visible in the main tree (footer total). */
export function countLive(db: Db): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(conversations)
    .where(
      and(
        isNull(conversations.trashedAt),
        isNull(conversations.archivedAt),
        ne(conversations.kind, "stage"),
      ),
    )
    .get();
  return row?.n ?? 0;
}
