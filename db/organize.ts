import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { removeAttachmentFilesSync } from "../lib/attachments";
import { deleteConversationAttachments } from "./attachments";
import { hostCommands } from "./schema";
import type {
  AttentionCounts,
  AttentionFlags,
  FolderNode,
  ShelvedItem,
  SidebarData,
  SidebarGroup,
  SidebarItem,
} from "../lib/read-models/sidebar";

// 0049: the view shapes moved to @/lib/read-models/sidebar; re-exported
// here so server-side importers keep one door into the store layer.
export type {
  AttentionCounts,
  AttentionFlags,
  FolderNode,
  ShelvedItem,
  SidebarData,
  SidebarGroup,
  SidebarItem,
} from "../lib/read-models/sidebar";
import type { Db } from "./index";
import {
  chatHarnessState,
  conversations,
  folders,
  harnessCalls,
  harnessEvents,
  harnessRuns,
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
 * 0046: every conversation's parent edge as ONE map, so the up-walk and
 * the down-walk always agree — a start_thread child's
 * conversations.parent_conversation_id. (0048: the other edge kind, a
 * historical run's machine_runs.parent_conversation_id, is gone with the
 * runs.)
 */
function conversationParentEdges(db: Conn): Map<string, string> {
  const parent = new Map<string, string>();
  for (const row of db
    .select({ id: conversations.id, parentId: conversations.parentConversationId })
    .from(conversations)
    .all()) {
    if (row.parentId) parent.set(row.id, row.parentId);
  }
  return parent;
}

/**
 * 0046 locked thread groups: the topmost ancestor of `id` — `id` itself
 * when it has no parent. A visited set stops a corrupted parent cycle
 * from looping: the walk ends at the node just before the repeat, which
 * is as far "up" as the data honestly goes.
 */
/** 0047: exported for the stats read (the group rollup resolves the
 *  root the same way the sidebar lock does). */
export function rootConversationId(db: Conn, id: string): string {
  getConversation(db, id);
  const parent = conversationParentEdges(db);
  const seen = new Set<string>([id]);
  let cursor = id;
  for (;;) {
    const parentId = parent.get(cursor) ?? null;
    if (parentId === null || seen.has(parentId)) return cursor;
    seen.add(parentId);
    cursor = parentId;
  }
}

/** 0046: the root AND every descendant conversation id (recursive; a
 *  visited set keeps a corrupted parent cycle from looping). */
/** 0047: exported for the stats read — the conversation group over both
 *  child kinds (start_thread chats + historical run conversations). */
export function conversationGroupIds(db: Conn, rootId: string): string[] {
  const parent = conversationParentEdges(db);
  const children = new Map<string, string[]>();
  for (const [childId, parentId] of parent) {
    const list = children.get(parentId) ?? [];
    list.push(childId);
    children.set(parentId, list);
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
 * mirror (events, extracted messages) and harness activity. 0046 locked
 * groups: the dragged id's root + every descendant join the purge.
 *
 * 0013: returns the sandbox ids the purged conversation OWNED — always
 * empty today (0048: historical runs, the only owner this ever
 * collected, are purged). The store is synchronous and cannot reach the
 * provider, so the caller destroys them (`destroyOwnedSandboxes`); the
 * sandbox rows stay as destroyed history (0011).
 */
export function deleteConversationForever(db: Db, id: string): string[] {
  const owned: string[] = [];
  const attachmentIds: string[] = [];
  db.transaction((tx) => {
    getConversation(tx, id);
    const sessions = conversationGroupIds(tx, rootConversationId(tx, id));
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
 *  ids the purged runs owned (the caller destroys them). 0046: a trashed
 *  GROUP expires together (setTrashed cascades the stamp), and the first
 *  member's deleteConversationForever purges the rest — so an id may
 *  already be gone when its row comes up. Skipping those keeps the
 *  reaper (app/layout.tsx's render path) from throwing; the batch's
 *  later rows and owned-sandbox ids still go through. */
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
  const owned: string[] = [];
  for (const { id } of expired) {
    try {
      owned.push(...deleteConversationForever(db, id));
    } catch (err) {
      // Already purged as part of an earlier member's group cascade —
      // nothing left to do for this id.
      if (err instanceof OrganizeError && err.code === "not-found") continue;
      throw err;
    }
  }
  return owned;
}

// ---------------------------------------------------------------------
// Sidebar read model

const SHELF_LIMIT = 200;

/** 0046: a synthetic harness row's title — the first line of the call's
 * task, clipped (the full task lives on the session page); the harness
 * name when the task has no usable first line. */
const HARNESS_TITLE_MAX = 60;

function harnessCallTitle(task: string, kind: string): string {
  const firstLine = task.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length > HARNESS_TITLE_MAX) {
    return `${firstLine.slice(0, HARNESS_TITLE_MAX - 1)}…`;
  }
  return firstLine.length > 0 ? firstLine : kind;
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
      workPhase: conversations.workPhase,
    })
    .from(conversations)
    .where(ne(conversations.kind, "stage"))
    .all();
  // 0046: one synthetic row per harness call, injected next to its
  // owning conversation wherever that conversation lands (a folder's
  // items or Unfiled) so buildSidebarTree nests it. Read-model only —
  // never a conversations row — so every COUNT stays conversation-only.
  const harnessByConversation = new Map<string, SidebarItem[]>();
  for (const call of db
    .select({
      id: harnessCalls.id,
      conversationId: harnessCalls.conversationId,
      kind: harnessCalls.kind,
      task: harnessCalls.task,
      status: harnessCalls.status,
      createdAt: harnessCalls.createdAt,
      updatedAt: harnessCalls.updatedAt,
      phase: harnessCalls.phase,
    })
    .from(harnessCalls)
    .all()) {
    const item: SidebarItem = {
      id: call.id,
      title: harnessCallTitle(call.task, call.kind),
      updatedAt: call.updatedAt,
      createdAt: call.createdAt,
      kind: "harness",
      runStatus: call.status,
      parentConversationId: call.conversationId,
      activeRunId: null,
      unread: false,
      needsYou: false,
      harness: call.kind,
      phase: call.phase,
    };
    const list = harnessByConversation.get(call.conversationId);
    if (list) list.push(item);
    else harnessByConversation.set(call.conversationId, [item]);
  }

  // 0046: child threads whose last turn ran out of steps. ONE batched
  // query over child conversations only, reading just each child's
  // newest assistant row (max rowid) — never a transcript scan.
  const exhaustedChildren = new Set(
    db
      .all<{ id: string }>(sql`
        select m.conversation_id as id from messages m
        join (
          select mm.conversation_id as cid, max(mm.rowid) as rid
          from messages mm join conversations c on c.id = mm.conversation_id
          where c.parent_conversation_id is not null and mm.role = 'assistant'
          group by mm.conversation_id
        ) newest on m.rowid = newest.rid
        where json_valid(m.metadata) and json_extract(m.metadata, '$.exhausted') = 1`)
      .map((r) => r.id),
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
    runStatus: null,
    parentConversationId: r.parentConversationId,
    activeRunId: r.activeRunId,
    unread: flags.unread.has(r.id),
    needsYou: flags.needsYou.has(r.id),
    threadStatus: exhaustedChildren.has(r.id) ? "exhausted" : null,
    phase: r.workPhase,
  });

  // 0046: append a conversation's synthetic harness rows to its own
  // list (they are never roots — the parent is present by construction).
  const withHarnessSessions = (rows: SidebarItem[]): SidebarItem[] => {
    const out = [...rows];
    for (const item of rows) out.push(...(harnessByConversation.get(item.id) ?? []));
    return out;
  };

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
          // Counts and activity stay conversation-only (0046): the
          // synthetic harness rows ride along but never count.
          const conversationItems = groupConversations
            .filter((r) => r.folderId === f.id)
            .map(toItem)
            .sort((a, b) => b.updatedAt - a.updatedAt);
          const items = withHarnessSessions(conversationItems);
          const activityAt = Math.max(
            f.createdAt,
            ...conversationItems.map((i) => i.updatedAt),
            ...subfolders.map((s) => s.activityAt),
          );
          return {
            id: f.id,
            name: f.name,
            activityAt,
            folders: subfolders,
            items,
            count: conversationItems.length + subfolders.reduce((n, s) => n + s.count, 0),
            attention: sumAttention(items, subfolders.map((s) => s.attention)),
          };
        })
        .sort((a, b) => b.activityAt - a.activityAt);

    const tree = build(null);
    // A conversation whose folder vanished (should not happen) still
    // surfaces as unfiled rather than disappearing.
    const unfiledConversations = groupConversations
      .filter((r) => !r.folderId || !folderIds.has(r.folderId))
      .map(toItem)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const unfiled = withHarnessSessions(unfiledConversations);
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
