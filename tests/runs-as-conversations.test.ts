import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { loadAttention, loadInbox, markSeen, markUnread } from "../db/attention";
import { appendMessages, ensureConversation } from "../db/chat";
import {
  beginStageRun,
  createMachine,
  createRun,
  getRun,
  markRunCancelled,
  runTitle,
  updateRun,
  updateStageRun,
} from "../db/machines";
import {
  createFolder,
  deleteConversationForever,
  loadSidebar,
  moveConversation,
  setTrashed,
} from "../db/organize";
import {
  conversations,
  harnessRuns,
  machineRuns,
  machineStageRuns,
  messages,
  projects,
} from "../db/schema";
import { searchConversations } from "../db/search";
import { conversationHref } from "../lib/conversation-href";

/** 0012: runs as conversations — the store-level invariants. */

const tdb = openDb(process.env.SWEATSHOP_DB!);
tdb.insert(projects).values({ id: "rac", name: "RAC", createdAt: 1 }).onConflictDoNothing().run();

createMachine(tdb, {
  id: "rac-think",
  name: "Think",
  definition: {
    workspace: "none",
    start: "draft",
    stages: {
      draft: { kind: "agent", title: "Draft", instructions: "draft", next: [{ to: "ok" }] },
      ok: { kind: "human", title: "OK?", instructions: "ok?", next: [{ to: "end", when: "yes" }] },
    },
  },
});

let msgSeq = 0;
/** Persist one assistant message into a conversation. */
function say(db: typeof tdb, conversationId: string, text: string) {
  appendMessages(db, conversationId, [
    { id: `msg_rac_${++msgSeq}`, role: "assistant", text, modelMessage: { role: "assistant", content: text } },
  ]);
}

const conv = (id: string) => tdb.select().from(conversations).where(eq(conversations.id, id)).get();
const allItems = () =>
  loadSidebar(tdb, loadAttention(tdb)).groups.flatMap((g) => [
    ...g.unfiled,
    ...g.folders.flatMap(function walk(f): typeof g.unfiled {
      return [...f.items, ...f.folders.flatMap(walk)];
    }),
  ]);

describe("createRun writes the run conversation", () => {
  it("inserts a kind=run row with the run id, the prompt title, and seen-now", () => {
    const run = createRun(tdb, { machineId: "rac-think", prompt: "\n  Summarize   the week\nmore detail" }, 1_000);
    expect(conv(run.id)).toMatchObject({
      kind: "run",
      title: "Summarize the week",
      projectId: null,
      createdAt: 1_000,
      lastSeenAt: 1_000,
    });
    expect(conversationHref({ id: run.id, kind: "run" })).toBe(`/r/${run.id}`);
  });

  it("clips long titles", () => {
    expect(runTitle("x".repeat(100))).toHaveLength(60);
  });
});

describe("run rows in the sidebar", () => {
  it("shows the run with its status and hides stage conversations", () => {
    const run = createRun(tdb, { machineId: "rac-think", prompt: "sidebar run" });
    ensureConversation(tdb, `${run.id}_0`, null, "stage");
    const items = allItems();
    expect(items.find((i) => i.id === run.id)).toMatchObject({ kind: "run", runStatus: "running" });
    expect(items.some((i) => i.id === `${run.id}_0`)).toBe(false);
  });

  it("files a run in a folder of its group like a chat", () => {
    const run = createRun(tdb, { machineId: "rac-think", prompt: "foldered run" });
    const folder = createFolder(tdb, { projectId: null, parentId: null, name: "RAC runs" });
    moveConversation(tdb, run.id, folder.id);
    const chats = loadSidebar(tdb).groups.find((g) => g.project === null)!;
    expect(chats.folders.find((f) => f.id === folder.id)!.items.map((i) => i.id)).toEqual([run.id]);
  });
});

describe("run attention", () => {
  it("is unread when it settles after last seen, and seen clears it", () => {
    const run = createRun(tdb, { machineId: "rac-think", prompt: "attention run" }, 2_000);
    expect(loadAttention(tdb).unread.has(run.id)).toBe(false);
    updateRun(tdb, run.id, { status: "running", currentStage: "draft" }, 2_500);
    expect(loadAttention(tdb).unread.has(run.id)).toBe(false);
    updateRun(tdb, run.id, { status: "completed" }, 3_000);
    expect(getRun(tdb, run.id).settledAt).toBe(3_000);
    expect(loadAttention(tdb).unread.has(run.id)).toBe(true);
    const card = loadInbox(tdb).unread.find((u) => u.id === run.id);
    expect(card).toMatchObject({ kind: "run", at: 3_000 });
    expect(card!.snippet).toMatch(/^completed/);

    expect(markSeen(tdb, run.id, 3_100)).toBe(true);
    expect(loadAttention(tdb).unread.has(run.id)).toBe(false);
    expect(markUnread(tdb, run.id)).toBe(true);
    expect(loadAttention(tdb).unread.has(run.id)).toBe(true);
  });

  it("puts a waiting gate on the run row as needs-you, without a thread card", () => {
    const run = createRun(tdb, { machineId: "rac-think", prompt: "gated run" });
    beginStageRun(tdb, { runId: run.id, seq: 0, stageId: "ok", kind: "human" });
    updateRun(tdb, run.id, { status: "waiting", currentStage: "ok" });
    const attention = loadAttention(tdb);
    expect(attention.needsYou.has(run.id)).toBe(true);
    const inbox = loadInbox(tdb);
    expect(inbox.needsYou.filter((n) => n.kind === "thread" && n.id === run.id)).toHaveLength(0);
    expect(inbox.needsYou.some((n) => n.kind === "machine" && n.runId === run.id)).toBe(true);
    expect(allItems().find((i) => i.id === run.id)?.needsYou).toBe(true);
  });

  it("never counts stage conversations as unread", () => {
    const run = createRun(tdb, { machineId: "rac-think", prompt: "stage unread" });
    const stage = `${run.id}_0`;
    ensureConversation(tdb, stage, null, "stage");
    say(tdb, stage, "stage output");
    expect(loadAttention(tdb).unread.has(stage)).toBe(false);
    expect(loadInbox(tdb).unread.some((u) => u.id === stage)).toBe(false);
  });
});

describe("cancel", () => {
  it("marks a live run cancelled, parks open visits, and ignores later writes", () => {
    const run = createRun(tdb, { machineId: "rac-think", prompt: "cancel me" });
    beginStageRun(tdb, { runId: run.id, seq: 0, stageId: "draft", kind: "agent" });
    expect(markRunCancelled(tdb, run.id)).toBe(true);
    expect(getRun(tdb, run.id).status).toBe("cancelled");
    const visit = tdb.select().from(machineStageRuns).where(eq(machineStageRuns.runId, run.id)).get();
    expect(visit).toMatchObject({ status: "parked", error: "run cancelled" });
    // A step still in flight must not revive it.
    updateRun(tdb, run.id, { status: "failed", error: "late" });
    expect(getRun(tdb, run.id)).toMatchObject({ status: "cancelled", error: null });
    expect(markRunCancelled(tdb, run.id)).toBe(false);
  });
});

describe("search", () => {
  it("reports a hit in a stage conversation as its parent run", () => {
    const run = createRun(tdb, { machineId: "rac-think", prompt: "search parent" });
    const stage = `${run.id}_0`;
    ensureConversation(tdb, stage, null, "stage");
    say(tdb, stage, "the zanzibar quokka report");
    const hits = searchConversations(tdb, "zanzibar quokka");
    expect(hits.map((h) => h.conversationId)).toEqual([run.id]);
    expect(hits[0]).toMatchObject({ kind: "run", matchedIn: "body" });
  });

  it("matches a run by its title and excludes trashed runs", () => {
    const run = createRun(tdb, { machineId: "rac-think", prompt: "platypus migration plan" });
    expect(searchConversations(tdb, "platypus").map((h) => h.conversationId)).toContain(run.id);
    setTrashed(tdb, run.id, true);
    expect(searchConversations(tdb, "platypus").map((h) => h.conversationId)).not.toContain(run.id);
  });
});

describe("purge", () => {
  it("deletes the run, its visits, stage conversations, and harness rows", () => {
    const run = createRun(tdb, { machineId: "rac-think", prompt: "purge me" });
    beginStageRun(tdb, { runId: run.id, seq: 0, stageId: "draft", kind: "agent" });
    updateStageRun(tdb, run.id, 0, { status: "completed" });
    const stage = `${run.id}_0`;
    ensureConversation(tdb, stage, null, "stage");
    say(tdb, stage, "bye");
    tdb.insert(harnessRuns).values({ sessionId: `${run.id}_1`, kind: "pi", status: "completed", startedAt: 1, lastAt: 1 }).run();
    // A same-prefix id that is not this run's visit must survive.
    const neighbor = `${run.id}x`;
    ensureConversation(tdb, neighbor);

    deleteConversationForever(tdb, run.id);
    expect(conv(run.id)).toBeUndefined();
    expect(conv(stage)).toBeUndefined();
    expect(tdb.select().from(machineRuns).where(eq(machineRuns.id, run.id)).get()).toBeUndefined();
    expect(tdb.select().from(machineStageRuns).where(eq(machineStageRuns.runId, run.id)).all()).toEqual([]);
    expect(tdb.select().from(messages).where(eq(messages.conversationId, stage)).all()).toEqual([]);
    expect(tdb.select().from(harnessRuns).where(eq(harnessRuns.sessionId, `${run.id}_1`)).all()).toEqual([]);
    expect(conv(neighbor)).toBeDefined();
  });
});

describe("0019 backfill", () => {
  it("creates run rows, marks stage rows, and stamps settled runs", () => {
    // A fresh db migrated only up to 0018, seeded with pre-0012 data,
    // then brought to head.
    const dir = mkdtempSync(path.join(tmpdir(), "sweatshop-0019-"));
    const sqlite = new Database(path.join(dir, "db.sqlite"));
    const migrationsFolder = path.join(process.cwd(), "drizzle");
    const journal = JSON.parse(
      readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    // drizzle has no "migrate to N", so run head-minus-0019 from a copy.
    const partial = path.join(dir, "drizzle");
    cpSync(migrationsFolder, partial, { recursive: true });
    const head = journal.entries.find((e) => e.tag.startsWith("0019_"))!;
    writeFileSync(
      path.join(partial, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx < head.idx) }),
    );
    rmSync(path.join(partial, `${head.tag}.sql`));
    migrate(drizzle(sqlite), { migrationsFolder: partial });

    sqlite.exec(`
      INSERT INTO machine_runs (id, machine_name, machine_version, definition, prompt, status, created_at, updated_at)
      VALUES ('mr_old1', 'M', 1, '{}', 'First line\nsecond', 'completed', 10, 20),
             ('mr_old2', 'M', 1, '{}', 'Still going', 'running', 30, 40);
      INSERT INTO conversations (id, created_at, updated_at) VALUES ('mr_old1_0', 10, 10), ('c_chat', 1, 1);
    `);
    migrate(drizzle(sqlite), { migrationsFolder });
    const db2 = drizzle(sqlite);
    const rows = db2.all<{ id: string; kind: string; title: string | null; last_seen_at: number }>(
      sql`select id, kind, title, last_seen_at from conversations order by id`,
    );
    expect(rows).toEqual([
      { id: "c_chat", kind: "chat", title: null, last_seen_at: 0 },
      { id: "mr_old1", kind: "run", title: "First line", last_seen_at: 20 },
      { id: "mr_old1_0", kind: "stage", title: null, last_seen_at: 0 },
      { id: "mr_old2", kind: "run", title: "Still going", last_seen_at: 40 },
    ]);
    const settled = db2.all<{ id: string; settled_at: number | null }>(
      sql`select id, settled_at from machine_runs order by id`,
    );
    expect(settled).toEqual([
      { id: "mr_old1", settled_at: 20 },
      { id: "mr_old2", settled_at: null },
    ]);
    sqlite.close();
  });
});
