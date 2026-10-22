import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../db";
import {
  loadAttention,
  loadInbox,
  loadPendingRequests,
  markAllSeen,
  markSeen,
  markUnread,
} from "../db/attention";
import { loadSidebar } from "../db/organize";
import { conversations, folders, messages, projects } from "../db/schema";
import { recordPendingInput, resolvePendingInput } from "../db/chat";

const tdb = openDb(process.env.SWEATSHOP_DB!);

let seq = 0;
const nextId = () => `msg_att${String(++seq).padStart(20, "0")}`;
const convId = () => `wrun_att_${++seq}`;

/** Seed a conversation and one message row — the source of truth. */
function say(sessionId: string, role: "user" | "assistant", text: string, atMs: number) {
  tdb
    .insert(conversations)
    .values({ id: sessionId, createdAt: atMs, updatedAt: atMs })
    .onConflictDoNothing()
    .run();
  tdb
    .insert(messages)
    .values({ id: nextId(), conversationId: sessionId, role, text, at: atMs })
    .run();
}

/** A pending ask_chad approval on `sessionId`. */
const ask = (sessionId: string, requestId: string) =>
  recordPendingInput(tdb, {
    id: requestId,
    conversationId: sessionId,
    kind: "approval",
    question: "Run rm -rf?",
  });

const resolve = (requestId: string) => resolvePendingInput(tdb, requestId, { approved: true });

describe("unread + seen", () => {
  it("is unread only once an assistant message is newer than last_seen_at", () => {
    const id = convId();
    say(id, "user", "hi", 1000);
    say(id, "assistant", "hello back", 2000);
    expect(loadAttention(tdb).unread.has(id)).toBe(true);

    expect(markSeen(tdb, id, 3000)).toBe(true); // was unread
    expect(loadAttention(tdb).unread.has(id)).toBe(false);
    expect(markSeen(tdb, id, 3500)).toBe(false); // already seen — no change

    say(id, "assistant", "more", 4000);
    expect(loadAttention(tdb).unread.has(id)).toBe(true);
  });

  it("a conversation with only the user's own message is not unread", () => {
    const id = convId();
    say(id, "user", "just me", 5000);
    expect(loadAttention(tdb).unread.has(id)).toBe(false);
  });

  it("markSeen never moves backwards; markUnread rewinds to just before the newest reply", () => {
    const id = convId();
    say(id, "assistant", "a", 10_000);
    markSeen(tdb, id, 20_000);
    markSeen(tdb, id, 15_000);
    expect(tdb.select().from(conversations).where(eq(conversations.id, id)).get()!.lastSeenAt).toBe(20_000);

    expect(markUnread(tdb, id)).toBe(true);
    expect(tdb.select().from(conversations).where(eq(conversations.id, id)).get()!.lastSeenAt).toBe(9_999);
    expect(loadAttention(tdb).unread.has(id)).toBe(true);
  });

  it("markUnread is a no-op without assistant output; unknown ids are not-found", () => {
    const id = convId();
    say(id, "user", "q", 1000);
    expect(markUnread(tdb, id)).toBe(false);
    expect(() => markSeen(tdb, "wrun_nope")).toThrow(/not found/);
    expect(() => markUnread(tdb, "wrun_nope")).toThrow(/not found/);
  });

  it("archived conversations are not unread; markAllSeen clears the live ones", () => {
    const a = convId();
    const b = convId();
    say(a, "assistant", "x", 1000);
    say(b, "assistant", "y", 1000);
    tdb.update(conversations).set({ archivedAt: 1 }).where(eq(conversations.id, b)).run();
    const state = loadAttention(tdb);
    expect(state.unread.has(a)).toBe(true);
    expect(state.unread.has(b)).toBe(false);
    markAllSeen(tdb, 9_000_000_000_000);
    expect(loadAttention(tdb).unread.size).toBe(0);
  });
});

describe("needs you", () => {
  it("survives opening the thread; clears when resolved", () => {
    const id = convId();
    say(id, "assistant", "may I?", 1000);
    ask(id, "rq1");

    markSeen(tdb, id, 3000); // opening the thread must NOT clear the ask
    expect(loadAttention(tdb).needsYou.has(id)).toBe(true);

    resolve("rq1");
    expect(loadAttention(tdb).needsYou.has(id)).toBe(false);
  });

  it("an exec approval carries its structured ask (terminal block, no JSON dump)", () => {
    const id = convId();
    say(id, "assistant", "checking the host", 1000);
    recordPendingInput(tdb, {
      id: "call_exec1",
      conversationId: id,
      kind: "approval",
      question: "exec on bee — crussell@10.10.0.12 (120s timeout)\n\n$ hostname",
      card: {
        type: "exec",
        host: "bee",
        user: "crussell",
        address: "10.10.0.12",
        command: "hostname",
        timeoutSec: 120,
        description: "Check which host answers",
      },
    });
    const requests = loadPendingRequests(tdb).get(id) ?? [];
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: "call_exec1",
      toolName: "exec",
      toolInput: null,
      exec: {
        host: "bee",
        user: "crussell",
        address: "10.10.0.12",
        command: "hostname",
        timeoutSec: 120,
        description: "Check which host answers",
      },
    });
    resolvePendingInput(tdb, "call_exec1", { approved: true });
  });

  it("pending inputs populate needs-you and clear on resolve", () => {
    const id = convId();
    say(id, "assistant", "chat reply", 1000);
    recordPendingInput(tdb, {
      id: "call_x1",
      conversationId: id,
      kind: "approval",
      question: "Proceed with the cutover?",
    });
    expect(loadAttention(tdb).needsYou.has(id)).toBe(true);
    const requests = loadPendingRequests(tdb).get(id) ?? [];
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: "call_x1",
      toolName: "ask_owner",
    });

    resolvePendingInput(tdb, "call_x1", { approved: true });
    expect(loadAttention(tdb).needsYou.has(id)).toBe(false);
  });

  it("loads an outline review as an Inbox outline request", () => {
    const id = convId();
    say(id, "assistant", "outline ready", 1000);
    recordPendingInput(tdb, {
      id: "outline_review1",
      conversationId: id,
      kind: "outline",
      question: "Review outline v2",
      card: {
        kind: "outline",
        version: 2,
        outline: { goal: "Ship it", steps: [{ id: "build", label: "Build", state: "active" }] },
      },
    });

    expect(loadPendingRequests(tdb, [id]).get(id)?.[0]).toMatchObject({
      requestId: "outline_review1",
      kind: "outline",
      toolName: "update_outline",
      toolInput: null,
      outline: { kind: "outline", version: 2, outline: { goal: "Ship it" } },
    });
    resolvePendingInput(tdb, "outline_review1", { approved: true });
  });

  it("appears once in the inbox: needs-you absorbs the same thread's unread", () => {
    const id = convId();
    say(id, "assistant", "needs a yes", 1000);
    ask(id, "rq2");
    const inbox = loadInbox(tdb);
    const hit = inbox.needsYou.find((n) => n.kind === "thread" && n.id === id);
    expect(hit).toMatchObject({ kind: "thread", unread: true });
    expect(inbox.unread.some((u) => u.id === id)).toBe(false);
  });

  it("lists unread threads with a snippet, newest first, with location", () => {
    tdb.insert(projects).values({ id: "att-p", name: "Att P", createdAt: 1 }).onConflictDoNothing().run();
    const older = convId();
    const newer = convId();
    say(older, "assistant", "older reply", 5_000);
    say(newer, "assistant", "newer   reply\nwith  spaces", 6_000);
    const inbox = loadInbox(tdb);
    const ids = inbox.unread.map((u) => u.id);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    expect(inbox.unread.find((u) => u.id === newer)!.snippet).toBe("newer reply with spaces");
  });

});

describe("sidebar roll-ups", () => {
  it("flags rows and rolls attention up through folders and groups", () => {
    tdb.insert(projects).values({ id: "att-s", name: "Att S", createdAt: 1 }).onConflictDoNothing().run();
    tdb.insert(folders).values([
      { id: "fld_att_top", projectId: "att-s", parentId: null, name: "Top", createdAt: 1 },
      { id: "fld_att_sub", projectId: "att-s", parentId: "fld_att_top", name: "Sub", createdAt: 1 },
    ]).run();
    const deep = convId();
    const loose = convId();
    for (const id of [deep, loose]) {
      tdb.insert(conversations).values({ id, projectId: "att-s", createdAt: 1, updatedAt: 1 }).onConflictDoNothing().run();
    }
    tdb.update(conversations).set({ folderId: "fld_att_sub" }).where(eq(conversations.id, deep)).run();
    say(deep, "assistant", "deep", 1000);
    ask(loose, "rq3");

    const data = loadSidebar(tdb, loadAttention(tdb));
    const group = data.groups.find((g) => g.project?.id === "att-s")!;
    expect(group.folders[0].folders[0].items[0]).toMatchObject({ id: deep, unread: true, needsYou: false });
    expect(group.folders[0].attention).toEqual({ unread: 1, needsYou: 0 });
    expect(group.unfiled.find((i) => i.id === loose)).toMatchObject({ needsYou: true });
    expect(group.attention).toEqual({ unread: 1, needsYou: 1 });
  });
});

describe("attention signature", () => {
  it("changes when unread, pending requests, or machine gates change — and only then", () => {
    const id = convId();
    const base = loadAttention(tdb).signature;
    expect(loadAttention(tdb).signature).toBe(base); // stable when idle

    say(id, "assistant", "ping", 1000);
    const afterUnread = loadAttention(tdb).signature;
    expect(afterUnread).not.toBe(base);

    ask(id, "sig1");
    const afterAsk = loadAttention(tdb).signature;
    expect(afterAsk).not.toBe(afterUnread);

    // A second request in an already-waiting thread still changes it.
    ask(id, "sig2");
    expect(loadAttention(tdb).signature).not.toBe(afterAsk);

    resolve("sig1");
    resolve("sig2");
    markSeen(tdb, id, 5000);
    expect(loadAttention(tdb).signature).toBe(base);
  });
});

describe("legacy plan reviews", () => {
  it("hides unresolved plan rows from attention and Inbox", () => {
    const id = convId();
    say(id, "user", "old thread", 1000);
    recordPendingInput(tdb, { id: `old_plan_${seq}`, conversationId: id, kind: "plan", question: "Plan v1" });
    expect(loadPendingRequests(tdb, [id]).get(id)).toBeUndefined();
    expect(loadAttention(tdb).needsYou.has(id)).toBe(false);
  });
});
