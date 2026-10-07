import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../db";
import {
  OrganizeError,
  TRASH_RETENTION_MS,
  createFolder,
  deleteConversationForever,
  deleteFolder,
  loadSidebar,
  moveConversation,
  moveFolder,
  purgeExpiredTrash,
  renameConversation,
  renameFolder,
  setArchived,
  setTrashed,
} from "../db/organize";
import {
  conversations,
  folders,
  harnessRuns,
  messages,
  projects,
} from "../db/schema";

const tdb = openDb(process.env.SWEATSHOP_DB!);

for (const id of ["org-a", "org-b"]) {
  tdb
    .insert(projects)
    .values({ id, name: id, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
}

let n = 0;
function convo(projectId: string | null, updatedAt = Date.now()) {
  n += 1;
  const id = `wrun_org_${n}`;
  tdb
    .insert(conversations)
    .values({ id, title: `t${n}`, projectId, createdAt: updatedAt, updatedAt })
    .run();
  return id;
}

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof OrganizeError ? err.code : `other:${String(err)}`;
  }
}

describe("folders", () => {
  it("creates nested folders and inherits the parent's group", () => {
    const top = createFolder(tdb, { projectId: "org-a", parentId: null, name: "Spikes" });
    const sub = createFolder(tdb, { projectId: "org-a", parentId: top.id, name: "Sandbox" });
    expect(sub.projectId).toBe("org-a");
    expect(sub.parentId).toBe(top.id);
  });

  it("rejects a subfolder in a different group than its parent", () => {
    const top = createFolder(tdb, { projectId: "org-a", parentId: null, name: "Mismatch" });
    expect(
      code(() => createFolder(tdb, { projectId: "org-b", parentId: top.id, name: "x" })),
    ).toBe("cross-group");
    expect(
      code(() => createFolder(tdb, { projectId: null, parentId: top.id, name: "x" })),
    ).toBe("cross-group");
  });

  it("enforces sibling-name uniqueness case-insensitively, per parent", () => {
    createFolder(tdb, { projectId: "org-b", parentId: null, name: "Docs" });
    expect(
      code(() => createFolder(tdb, { projectId: "org-b", parentId: null, name: "  docs " })),
    ).toBe("duplicate-name");
    // Same name in another group or under another parent is fine.
    createFolder(tdb, { projectId: "org-a", parentId: null, name: "Docs" });
    const p = createFolder(tdb, { projectId: "org-b", parentId: null, name: "Parent" });
    createFolder(tdb, { projectId: "org-b", parentId: p.id, name: "Docs" });
  });

  it("rejects empty names and renames with the same rules", () => {
    expect(code(() => createFolder(tdb, { projectId: null, parentId: null, name: "  " }))).toBe(
      "invalid",
    );
    const a = createFolder(tdb, { projectId: null, parentId: null, name: "Ra" });
    createFolder(tdb, { projectId: null, parentId: null, name: "Rb" });
    expect(code(() => renameFolder(tdb, a.id, "rb"))).toBe("duplicate-name");
    renameFolder(tdb, a.id, "Renamed");
    expect(tdb.select().from(folders).where(eq(folders.id, a.id)).get()?.name).toBe("Renamed");
  });

  it("refuses moves into itself or a descendant, and across groups", () => {
    const a = createFolder(tdb, { projectId: "org-a", parentId: null, name: "Cyc-A" });
    const b = createFolder(tdb, { projectId: "org-a", parentId: a.id, name: "Cyc-B" });
    const c = createFolder(tdb, { projectId: "org-a", parentId: b.id, name: "Cyc-C" });
    expect(code(() => moveFolder(tdb, a.id, a.id))).toBe("cycle");
    expect(code(() => moveFolder(tdb, a.id, c.id))).toBe("cycle");
    const other = createFolder(tdb, { projectId: "org-b", parentId: null, name: "Cyc-Other" });
    expect(code(() => moveFolder(tdb, a.id, other.id))).toBe("cross-group");
    moveFolder(tdb, c.id, null);
    expect(tdb.select().from(folders).where(eq(folders.id, c.id)).get()?.parentId).toBeNull();
  });

  it("deleting a folder promotes children and conversations one level", () => {
    const top = createFolder(tdb, { projectId: "org-a", parentId: null, name: "Del-Top" });
    const mid = createFolder(tdb, { projectId: "org-a", parentId: top.id, name: "Del-Mid" });
    const leaf = createFolder(tdb, { projectId: "org-a", parentId: mid.id, name: "Del-Leaf" });
    // A same-named sibling at the destination forces a suffix on promotion.
    createFolder(tdb, { projectId: "org-a", parentId: top.id, name: "Del-Leaf" });
    const c = convo("org-a");
    moveConversation(tdb, c, mid.id);

    deleteFolder(tdb, mid.id);

    const promoted = tdb.select().from(folders).where(eq(folders.id, leaf.id)).get();
    expect(promoted?.parentId).toBe(top.id);
    expect(promoted?.name).toBe("Del-Leaf (2)");
    expect(tdb.select().from(folders).where(eq(folders.id, mid.id)).get()).toBeUndefined();
    expect(
      tdb.select().from(conversations).where(eq(conversations.id, c)).get()?.folderId,
    ).toBe(top.id);
  });
});

describe("filing conversations", () => {
  it("files within the same group, unfiles with null, never bumps updatedAt", () => {
    const f = createFolder(tdb, { projectId: "org-a", parentId: null, name: "File-A" });
    const c = convo("org-a", 1_000);
    moveConversation(tdb, c, f.id);
    const row = () => tdb.select().from(conversations).where(eq(conversations.id, c)).get();
    expect(row()?.folderId).toBe(f.id);
    expect(row()?.updatedAt).toBe(1_000);
    moveConversation(tdb, c, null);
    expect(row()?.folderId).toBeNull();
  });

  it("rejects filing into another project's folder, or Chats ↔ project", () => {
    const fa = createFolder(tdb, { projectId: "org-a", parentId: null, name: "File-X" });
    const chats = createFolder(tdb, { projectId: null, parentId: null, name: "File-Chats" });
    const inB = convo("org-b");
    const unbound = convo(null);
    expect(code(() => moveConversation(tdb, inB, fa.id))).toBe("cross-group");
    expect(code(() => moveConversation(tdb, unbound, fa.id))).toBe("cross-group");
    expect(code(() => moveConversation(tdb, inB, chats.id))).toBe("cross-group");
    moveConversation(tdb, unbound, chats.id);
  });

  it("reports not-found for unknown ids", () => {
    expect(code(() => moveConversation(tdb, "nope", null))).toBe("not-found");
    expect(code(() => moveFolder(tdb, "nope", null))).toBe("not-found");
  });
});

describe("rename, archive, trash", () => {
  it("manual rename pins the title source", () => {
    const c = convo(null);
    renameConversation(tdb, c, "  My   title ");
    const row = tdb.select().from(conversations).where(eq(conversations.id, c)).get();
    expect(row?.title).toBe("My title");
    expect(row?.titleSource).toBe("manual");
  });

  it("archive keeps the folder and is reversible", () => {
    const f = createFolder(tdb, { projectId: "org-a", parentId: null, name: "Arch" });
    const c = convo("org-a");
    moveConversation(tdb, c, f.id);
    setArchived(tdb, c, true);
    const row = () => tdb.select().from(conversations).where(eq(conversations.id, c)).get();
    expect(row()?.archivedAt).not.toBeNull();
    expect(row()?.folderId).toBe(f.id);
    setArchived(tdb, c, false);
    expect(row()?.archivedAt).toBeNull();
  });

  it("delete-forever removes messages and harness rows", () => {
    const c = convo(null);
    tdb.insert(messages).values({
      id: `evt_m_${c}`, conversationId: c, role: "user", text: "purgeable zebra", at: 1,
    }).run();
    tdb.insert(harnessRuns).values({
      sessionId: c, kind: "pi", status: "completed", startedAt: 1, lastAt: 1,
    }).run();
    deleteConversationForever(tdb, c);
    expect(tdb.select().from(conversations).where(eq(conversations.id, c)).get()).toBeUndefined();
    expect(tdb.select().from(messages).where(eq(messages.conversationId, c)).all()).toEqual([]);
    expect(
      tdb.select().from(harnessRuns).where(eq(harnessRuns.sessionId, c)).all(),
    ).toEqual([]);
  });

  it("purges only trash older than the retention window", () => {
    const old = convo(null);
    const fresh = convo(null);
    const now = Date.now();
    tdb.update(conversations).set({ trashedAt: now - TRASH_RETENTION_MS - 1000 })
      .where(eq(conversations.id, old)).run();
    setTrashed(tdb, fresh, true);
    purgeExpiredTrash(tdb, now);
    expect(tdb.select().from(conversations).where(eq(conversations.id, old)).get()).toBeUndefined();
    expect(tdb.select().from(conversations).where(eq(conversations.id, fresh)).get()).toBeDefined();
  });
});

describe("loadSidebar", () => {
  it("builds the tree, inbox, and shelves; folders sort by activity", () => {
    tdb.insert(projects).values({ id: "org-side", name: "org-side", createdAt: 1 }).run();
    const older = createFolder(tdb, { projectId: "org-side", parentId: null, name: "Older" });
    const newer = createFolder(tdb, { projectId: "org-side", parentId: null, name: "Newer" });
    const sub = createFolder(tdb, { projectId: "org-side", parentId: older.id, name: "Sub" });
    const now = Date.now();
    const cOld = convo("org-side", now - 5000);
    const cNew = convo("org-side", now + 5000);
    const cInbox = convo("org-side", now);
    const cArch = convo("org-side", now);
    const cTrash = convo("org-side", now);
    moveConversation(tdb, cOld, newer.id);
    moveConversation(tdb, cNew, sub.id);
    setArchived(tdb, cArch, true);
    setTrashed(tdb, cTrash, true);

    const data = loadSidebar(tdb);
    const group = data.groups.find((g) => g.project?.id === "org-side")!;
    // "Older" holds the newest activity via its descendant, so it sorts first.
    expect(group.folders.map((f) => f.name)).toEqual(["Older", "Newer"]);
    expect(group.folders[0].folders[0].items.map((i) => i.id)).toEqual([cNew]);
    expect(group.folders[0].count).toBe(1);
    expect(group.unfiled.map((i) => i.id)).toEqual([cInbox]);
    expect(data.archived.some((i) => i.id === cArch)).toBe(true);
    expect(data.trashed.some((i) => i.id === cTrash)).toBe(true);
    expect(group.unfiled.concat(group.folders[0].items).some((i) => i.id === cTrash)).toBe(false);
  });
});
