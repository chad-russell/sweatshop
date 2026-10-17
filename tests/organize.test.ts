import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { openDb } from "../db";
import { createHarnessCall } from "../db/harness-calls";
import { buildSidebarTree } from "../lib/sidebar-tree";
import { conversationHref } from "../lib/conversation-href";
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
  chatHarnessState,
  conversations,
  folders,
  harnessRuns,
  machineRuns,
  messages,
  pendingInputs,
  projects,
  steerQueue,
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

/** A child conversation (start_thread shape): same project as its
 * parent, linked via parent_conversation_id. */
function childConvo(parentId: string, updatedAt = Date.now()) {
  n += 1;
  const id = `wrun_org_${n}`;
  const parent = tdb
    .select({ projectId: conversations.projectId })
    .from(conversations)
    .where(eq(conversations.id, parentId))
    .get()!;
  tdb
    .insert(conversations)
    .values({
      id,
      title: `t${n}`,
      projectId: parent.projectId,
      parentConversationId: parentId,
      createdAt: updatedAt,
      updatedAt,
    })
    .run();
  return id;
}

/** A historical machine run child: a kind:"run" conversation (the id IS
 * the machine_runs id) linked to its parent chat via
 * machine_runs.parent_conversation_id — the only home of that edge. */
function runConvo(parentChatId: string) {
  n += 1;
  const id = `mr_org_${n}`;
  const parent = tdb
    .select({ projectId: conversations.projectId })
    .from(conversations)
    .where(eq(conversations.id, parentChatId))
    .get()!;
  tdb
    .insert(conversations)
    .values({
      id,
      title: `run ${n}`,
      projectId: parent.projectId,
      kind: "run",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  tdb
    .insert(machineRuns)
    .values({
      id,
      status: "completed",
      machineName: "R",
      machineVersion: 1,
      definition: "{}",
      prompt: "go",
      parentConversationId: parentChatId,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  return id;
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

  it("delete-forever removes steer queue, harness state, and pending inputs (FKs into conversations)", () => {
    // Found live 2026-10-08: purging a conversation with harness history
    // or answered approvals threw FOREIGN KEY — the three tables were
    // never part of the teardown.
    const c = convo(null);
    tdb.insert(steerQueue).values({ id: `sq_${c}`, conversationId: c, text: "queued", createdAt: 1 }).run();
    tdb.insert(chatHarnessState).values({ conversationId: c, harness: "pi", resumeFrom: "{}", updatedAt: 1 }).run();
    tdb.insert(pendingInputs).values({
      id: `pi_${c}`, conversationId: c, kind: "approval", question: "ok?", createdAt: 1,
      resolvedAt: 2, answer: '{"approved":true}',
    }).run();
    expect(() => deleteConversationForever(tdb, c)).not.toThrow();
    expect(tdb.select().from(conversations).where(eq(conversations.id, c)).get()).toBeUndefined();
    expect(tdb.select().from(steerQueue).where(eq(steerQueue.conversationId, c)).all()).toEqual([]);
    expect(tdb.select().from(chatHarnessState).where(eq(chatHarnessState.conversationId, c)).all()).toEqual([]);
    expect(tdb.select().from(pendingInputs).where(eq(pendingInputs.conversationId, c)).all()).toEqual([]);
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

describe("locked thread groups (0046)", () => {
  it("dragging a grandchild moves the whole group to the new folder", () => {
    const f = createFolder(tdb, { projectId: "org-a", parentId: null, name: "Lock-Group" });
    const root = convo("org-a");
    const mid = childConvo(root);
    const leaf = childConvo(mid);
    moveConversation(tdb, leaf, f.id);
    const folder = (id: string) =>
      tdb.select().from(conversations).where(eq(conversations.id, id)).get()?.folderId;
    expect(folder(root)).toBe(f.id);
    expect(folder(mid)).toBe(f.id);
    expect(folder(leaf)).toBe(f.id);
    // Unfiling a child unfiles the group too.
    moveConversation(tdb, mid, null);
    expect(folder(root)).toBeNull();
    expect(folder(leaf)).toBeNull();
  });

  it("still rejects cross-group moves from a child (the check uses the root's project)", () => {
    const root = convo("org-b");
    const kid = childConvo(root);
    const fa = createFolder(tdb, { projectId: "org-a", parentId: null, name: "Lock-X" });
    expect(code(() => moveConversation(tdb, kid, fa.id))).toBe("cross-group");
  });

  it("archive and trash cascade to descendants; restore clears the group", () => {
    const root = convo("org-a");
    const kid = childConvo(root);
    const grand = childConvo(kid);
    setArchived(tdb, grand, true);
    const archived = (id: string) =>
      tdb.select().from(conversations).where(eq(conversations.id, id)).get()?.archivedAt;
    expect(archived(root)).not.toBeNull();
    expect(archived(kid)).not.toBeNull();
    expect(archived(grand)).not.toBeNull();
    setArchived(tdb, root, false);
    expect(archived(root)).toBeNull();
    expect(archived(grand)).toBeNull();

    setTrashed(tdb, kid, true);
    const trashed = (id: string) =>
      tdb.select().from(conversations).where(eq(conversations.id, id)).get()?.trashedAt;
    expect(trashed(root)).not.toBeNull();
    expect(trashed(grand)).not.toBeNull();
    setTrashed(tdb, grand, false);
    expect(trashed(root)).toBeNull();
    expect(trashed(kid)).toBeNull();
  });

  it("delete-forever purges the whole group, from any member", () => {
    const root = convo("org-a");
    const kid = childConvo(root);
    for (const id of [root, kid]) {
      tdb.insert(messages).values({
        id: `evt_m_${id}`, conversationId: id, role: "user", text: "group purge", at: 1,
      }).run();
    }
    // Deleting the CHILD takes the root with it (the dragged id is
    // normalized to the group's root).
    deleteConversationForever(tdb, kid);
    expect(tdb.select().from(conversations).where(eq(conversations.id, root)).get()).toBeUndefined();
    expect(tdb.select().from(conversations).where(eq(conversations.id, kid)).get()).toBeUndefined();
    expect(tdb.select().from(messages).where(eq(messages.conversationId, root)).all()).toEqual([]);
    expect(tdb.select().from(messages).where(eq(messages.conversationId, kid)).all()).toEqual([]);
  });

  it("a historical machine run locks to its parent chat (machine_runs edge)", () => {
    const chat = convo("org-a");
    const run = runConvo(chat);
    const folder = (id: string) =>
      tdb.select().from(conversations).where(eq(conversations.id, id)).get()?.folderId;
    const f = createFolder(tdb, { projectId: "org-a", parentId: null, name: "Lock-Run" });
    // Dragging the CHAT files the run too.
    moveConversation(tdb, chat, f.id);
    expect(folder(chat)).toBe(f.id);
    expect(folder(run)).toBe(f.id);
    // Dragging the RUN normalizes up to the chat and files the family.
    const f2 = createFolder(tdb, { projectId: "org-a", parentId: null, name: "Lock-Run-2" });
    moveConversation(tdb, run, f2.id);
    expect(folder(chat)).toBe(f2.id);
    expect(folder(run)).toBe(f2.id);
    // Trashing the chat trashes the run; restore from either side clears.
    setTrashed(tdb, chat, true);
    const trashed = (id: string) =>
      tdb.select().from(conversations).where(eq(conversations.id, id)).get()?.trashedAt;
    expect(trashed(run)).not.toBeNull();
    setTrashed(tdb, run, false);
    expect(trashed(chat)).toBeNull();
  });

  it("delete-forever on the chat purges its run conversation AND the machine_runs row", () => {
    const chat = convo("org-a");
    const run = runConvo(chat);
    tdb.insert(messages).values({
      id: `evt_m_${run}`, conversationId: run, role: "user", text: "run msg", at: 1,
    }).run();
    deleteConversationForever(tdb, chat);
    expect(tdb.select().from(conversations).where(eq(conversations.id, chat)).get()).toBeUndefined();
    expect(tdb.select().from(conversations).where(eq(conversations.id, run)).get()).toBeUndefined();
    expect(tdb.select().from(machineRuns).where(eq(machineRuns.id, run)).get()).toBeUndefined();
    expect(tdb.select().from(messages).where(eq(messages.conversationId, run)).all()).toEqual([]);
  });

  it("purgeExpiredTrash tolerates an expired GROUP: no throw, all rows gone (review fix)", () => {
    // The group expires together (setTrashed cascades the stamp), so
    // the reaper's batch lists parent AND child — the first delete
    // purges both, and the second id is already gone. That used to
    // throw "conversation … not found" out of the layout render path.
    const root = convo("org-a");
    const kid = childConvo(root);
    setTrashed(tdb, root, true);
    const expired = Date.now() - TRASH_RETENTION_MS - 1000;
    tdb.update(conversations).set({ trashedAt: expired })
      .where(inArray(conversations.id, [root, kid])).run();
    expect(() => purgeExpiredTrash(tdb, Date.now())).not.toThrow();
    expect(tdb.select().from(conversations).where(eq(conversations.id, root)).get()).toBeUndefined();
    expect(tdb.select().from(conversations).where(eq(conversations.id, kid)).get()).toBeUndefined();
  });

  it("a corrupted parent cycle cannot hang a move — something sane still files", () => {
    const a = convo("org-a");
    const b = childConvo(a);
    // Raw corruption: point a's parent at b, closing a 2-node cycle.
    tdb.update(conversations).set({ parentConversationId: b }).where(eq(conversations.id, a)).run();
    const f = createFolder(tdb, { projectId: "org-a", parentId: null, name: "Lock-Cycle" });
    expect(() => moveConversation(tdb, a, f.id)).not.toThrow();
    const folder = (id: string) =>
      tdb.select().from(conversations).where(eq(conversations.id, id)).get()?.folderId;
    // Both members of the cycle get filed — the walk stops at the node
    // before the repeat and the group covers everything reachable.
    expect(folder(a)).toBe(f.id);
    expect(folder(b)).toBe(f.id);
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

  it("harness calls nest under their conversation; counts stay conversation-only (0046)", () => {
    const c = convo("org-side");
    const call = createHarnessCall(tdb, {
      conversationId: c,
      kind: "pi",
      task: "review the diff\nsecond line never shown",
    });

    // Unfiled: the synthetic row rides along in the same list.
    let data = loadSidebar(tdb);
    let g = data.groups.find((gr) => gr.project?.id === "org-side")!;
    expect(g.unfiled.some((i) => i.id === call.id)).toBe(true);
    const item = g.unfiled.find((i) => i.id === call.id)!;
    expect(item).toMatchObject({
      kind: "harness",
      runStatus: "running",
      harness: "pi",
      parentConversationId: c,
      title: "review the diff",
    });
    // buildSidebarTree nests it, and a running call rolls up to the parent.
    const tree = buildSidebarTree(g.unfiled).find((t) => t.id === c)!;
    expect(tree.children.map((ch) => ch.id)).toEqual([call.id]);
    expect(tree.anyDescendantRunning).toBe(true);

    // Filed: the call follows its conversation into the folder, but the
    // folder's count excludes it.
    const f = createFolder(tdb, { projectId: "org-side", parentId: null, name: "Harness" });
    moveConversation(tdb, c, f.id);
    data = loadSidebar(tdb);
    g = data.groups.find((gr) => gr.project?.id === "org-side")!;
    const folder = g.folders.find((fn) => fn.id === f.id)!;
    expect(folder.items.map((i) => i.id)).toEqual([c, call.id]);
    expect(folder.count).toBe(1);

    // A long task clips to ~60 chars; an empty one falls back to the kind.
    const long = createHarnessCall(tdb, {
      conversationId: c,
      kind: "claude",
      task: `${"x".repeat(100)}\nmore`,
    });
    const blank = createHarnessCall(tdb, { conversationId: c, kind: "cursor", task: "  \n  " });
    data = loadSidebar(tdb);
    const items = data.groups.find((gr) => gr.project?.id === "org-side")!.folders
      .find((fn) => fn.id === f.id)!.items;
    expect(items.find((i) => i.id === long.id)?.title).toBe(`${"x".repeat(59)}…`);
    expect(items.find((i) => i.id === blank.id)?.title).toBe("cursor");
    expect(items.find((i) => i.id === blank.id)?.harness).toBe("cursor");
  });

  it("two calls of one harness under one conversation get distinct hrefs (0046)", () => {
    const c = convo("org-side");
    const a = createHarnessCall(tdb, { conversationId: c, kind: "pi", task: "first" }, 1_000);
    const b = createHarnessCall(tdb, { conversationId: c, kind: "pi", task: "second" }, 2_000);
    const g = loadSidebar(tdb).groups.find((gr) => gr.project?.id === "org-side")!;
    const hrefs = g.unfiled.filter((i) => i.id === a.id || i.id === b.id).map(conversationHref);
    expect(hrefs.sort()).toEqual([`/h/pi/${c}/${a.id}`, `/h/pi/${c}/${b.id}`].sort());
  });

  it("a historical run nests under the chat that started it (machine_runs link, 0046)", () => {
    const parent = convo("org-side");
    const runId = `mr_org_hist_${n}`;
    tdb.insert(conversations).values({
      id: runId, title: "old run", projectId: "org-side", kind: "run", createdAt: 1, updatedAt: 1,
    }).run();
    tdb.insert(machineRuns).values({
      id: runId, status: "completed", machineName: "H", machineVersion: 1,
      definition: "{}", prompt: "go", parentConversationId: parent,
      createdAt: 1, updatedAt: 1,
    }).run();

    const data = loadSidebar(tdb);
    const g = data.groups.find((gr) => gr.project?.id === "org-side")!;
    const run = g.unfiled.find((i) => i.id === runId);
    expect(run).toMatchObject({ kind: "run", runStatus: "completed", parentConversationId: parent });
    const roots = buildSidebarTree(g.unfiled);
    const parentNode = roots.find((t) => t.id === parent)!;
    expect(parentNode.children.map((ch) => ch.id)).toContain(runId);
    expect(roots.some((t) => t.id === runId)).toBe(false); // nested, not a root
  });
});
