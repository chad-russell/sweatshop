import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../db";
import {
  loadAttention,
  loadInbox,
  markAllSeen,
  markSeen,
  markUnread,
  pendingFromEvents,
  type EventRow,
} from "../db/attention";
import { mirrorStreamEvent } from "../db/mirror";
import { loadSidebar } from "../db/organize";
import { conversations, folders, ticketRuns, projects } from "../db/schema";

const tdb = openDb(process.env.SWEATSHOP_DB!);

let seq = 0;
const nextId = () => `evt_att${String(++seq).padStart(20, "0")}`;
const convId = () => `wrun_att_${++seq}`;

function emit(sessionId: string, type: string, data: unknown, atMs: number) {
  mirrorStreamEvent(sessionId, {
    type,
    data,
    meta: { id: nextId(), at: new Date(atMs).toISOString() },
  });
}

const approval = (requestId: string) => ({
  requestId,
  kind: "tool-approval",
  prompt: "Run rm -rf?",
  action: { kind: "tool-call", callId: "c1", toolName: "bash", input: { command: "ls" } },
  options: [
    { id: "approve", label: "Approve", style: "primary" },
    { id: "cancel", label: "Deny", style: "danger" },
  ],
});

const row = (type: string, data: unknown, at = 1): EventRow => ({
  type,
  event: JSON.stringify({ type, data }),
  at,
});

describe("pendingFromEvents", () => {
  it("keeps a request until input.resolved names it", () => {
    const requested = row("input.requested", { requests: [approval("r1"), approval("r2")] });
    expect(pendingFromEvents([requested]).map((r) => r.requestId)).toEqual(["r1", "r2"]);

    const partial = row("input.resolved", { resolutions: [{ requestId: "r1", outcome: "approved" }] });
    expect(pendingFromEvents([requested, partial]).map((r) => r.requestId)).toEqual(["r2"]);
  });

  it("parses kind, tool, options", () => {
    const [r] = pendingFromEvents([row("input.requested", { requests: [approval("r1")] })]);
    expect(r).toMatchObject({
      kind: "tool-approval",
      toolName: "bash",
      toolInput: { command: "ls" },
      prompt: "Run rm -rf?",
    });
    expect(r.options.map((o) => o.id)).toEqual(["approve", "cancel"]);
  });

  it("clears on context.cleared and session end; ignores junk", () => {
    const requested = row("input.requested", { requests: [approval("r1")] });
    expect(pendingFromEvents([requested, row("context.cleared", {})])).toEqual([]);
    expect(pendingFromEvents([requested, row("session.failed", {})])).toEqual([]);
    expect(
      pendingFromEvents([
        row("input.requested", { requests: [{ nope: true }, null, { requestId: "x", kind: "weird" }] }),
        { type: "input.requested", event: "{not json", at: 1 },
      ]),
    ).toEqual([]);
  });

  it("a later request after an earlier resolution is pending again", () => {
    const rows = [
      row("input.requested", { requests: [approval("r1")] }, 1),
      row("input.resolved", { resolutions: [{ requestId: "r1", outcome: "approved" }] }, 2),
      row("input.requested", { requests: [approval("r3")] }, 3),
    ];
    expect(pendingFromEvents(rows).map((r) => r.requestId)).toEqual(["r3"]);
  });
});

describe("unread + seen", () => {
  it("is unread only once an assistant message is newer than last_seen_at", () => {
    const id = convId();
    emit(id, "message.received", { message: "hi" }, 1000);
    emit(id, "message.completed", { message: "hello back" }, 2000);
    expect(loadAttention(tdb).unread.has(id)).toBe(true);

    expect(markSeen(tdb, id, 3000)).toBe(true); // was unread
    expect(loadAttention(tdb).unread.has(id)).toBe(false);
    expect(markSeen(tdb, id, 3500)).toBe(false); // already seen — no change

    emit(id, "message.completed", { message: "more" }, 4000);
    expect(loadAttention(tdb).unread.has(id)).toBe(true);
  });

  it("a conversation with only the user's own message is not unread", () => {
    const id = convId();
    emit(id, "message.received", { message: "just me" }, 5000);
    expect(loadAttention(tdb).unread.has(id)).toBe(false);
  });

  it("markSeen never moves backwards; markUnread rewinds to just before the newest reply", () => {
    const id = convId();
    emit(id, "message.completed", { message: "a" }, 10_000);
    markSeen(tdb, id, 20_000);
    markSeen(tdb, id, 15_000);
    expect(tdb.select().from(conversations).where(eq(conversations.id, id)).get()!.lastSeenAt).toBe(20_000);

    expect(markUnread(tdb, id)).toBe(true);
    expect(tdb.select().from(conversations).where(eq(conversations.id, id)).get()!.lastSeenAt).toBe(9_999);
    expect(loadAttention(tdb).unread.has(id)).toBe(true);
  });

  it("markUnread is a no-op without assistant output; unknown ids are not-found", () => {
    const id = convId();
    emit(id, "message.received", { message: "q" }, 1000);
    expect(markUnread(tdb, id)).toBe(false);
    expect(() => markSeen(tdb, "wrun_nope")).toThrow(/not found/);
    expect(() => markUnread(tdb, "wrun_nope")).toThrow(/not found/);
  });

  it("archived conversations are not unread; markAllSeen clears the live ones", () => {
    const a = convId();
    const b = convId();
    emit(a, "message.completed", { message: "x" }, 1000);
    emit(b, "message.completed", { message: "y" }, 1000);
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
    emit(id, "message.completed", { message: "may I?" }, 1000);
    emit(id, "input.requested", { requests: [approval("rq1")] }, 2000);

    markSeen(tdb, id, 3000); // opening the thread must NOT clear the ask
    expect(loadAttention(tdb).needsYou.has(id)).toBe(true);

    emit(id, "input.resolved", { resolutions: [{ requestId: "rq1", outcome: "approved" }] }, 4000);
    expect(loadAttention(tdb).needsYou.has(id)).toBe(false);
  });

  it("appears once in the inbox: needs-you absorbs the same thread's unread", () => {
    const id = convId();
    emit(id, "message.completed", { message: "needs a yes" }, 1000);
    emit(id, "input.requested", { requests: [approval("rq2")] }, 2000);
    const inbox = loadInbox(tdb);
    const hit = inbox.needsYou.find((n) => n.kind === "thread" && n.id === id);
    expect(hit).toMatchObject({ kind: "thread", unread: true });
    expect(inbox.unread.some((u) => u.id === id)).toBe(false);
  });

  it("lists unread threads with a snippet, newest first, with location", () => {
    tdb.insert(projects).values({ id: "att-p", name: "Att P", createdAt: 1 }).onConflictDoNothing().run();
    const older = convId();
    const newer = convId();
    emit(older, "message.completed", { message: "older reply" }, 5_000);
    emit(newer, "message.completed", { message: "newer   reply\nwith  spaces" }, 6_000);
    const inbox = loadInbox(tdb);
    const ids = inbox.unread.map((u) => u.id);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    expect(inbox.unread.find((u) => u.id === newer)!.snippet).toBe("newer reply with spaces");
  });

  it("includes ticket runs parked at the plan gate", () => {
    tdb.insert(projects).values({ id: "att-t", name: "Att T", createdAt: 1 }).onConflictDoNothing().run();
    tdb
      .insert(ticketRuns)
      .values({
        id: "tkt_att_1",
        projectId: "att-t",
        ticket: "do the thing",
        status: "awaiting-approval",
        detail: "the plan",
        createdAt: 1,
        updatedAt: 2,
      })
      .run();
    const gate = loadInbox(tdb).needsYou.find((n) => n.kind === "ticket" && n.id === "tkt_att_1");
    expect(gate).toMatchObject({ plan: "the plan", projectName: "Att T" });
    expect(loadAttention(tdb).ticketGates).toBeGreaterThanOrEqual(1);
    tdb.update(ticketRuns).set({ status: "implementing" }).where(eq(ticketRuns.id, "tkt_att_1")).run();
    expect(loadInbox(tdb).needsYou.some((n) => n.kind === "ticket" && n.id === "tkt_att_1")).toBe(false);
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
    emit(deep, "message.completed", { message: "deep" }, 1000);
    emit(loose, "input.requested", { requests: [approval("rq3")] }, 1000);

    const data = loadSidebar(tdb, loadAttention(tdb));
    const group = data.groups.find((g) => g.project?.id === "att-s")!;
    expect(group.folders[0].folders[0].items[0]).toMatchObject({ id: deep, unread: true, needsYou: false });
    expect(group.folders[0].attention).toEqual({ unread: 1, needsYou: 0 });
    expect(group.unfiled.find((i) => i.id === loose)).toMatchObject({ needsYou: true });
    expect(group.attention).toEqual({ unread: 1, needsYou: 1 });
  });
});

describe("attention signature", () => {
  it("changes when unread, pending requests, or ticket gates change — and only then", () => {
    const id = convId();
    const base = loadAttention(tdb).signature;
    expect(loadAttention(tdb).signature).toBe(base); // stable when idle

    emit(id, "message.completed", { message: "ping" }, 1000);
    const afterUnread = loadAttention(tdb).signature;
    expect(afterUnread).not.toBe(base);

    emit(id, "input.requested", { requests: [approval("sig1")] }, 2000);
    const afterAsk = loadAttention(tdb).signature;
    expect(afterAsk).not.toBe(afterUnread);

    // A second request in an already-waiting thread still changes it.
    emit(id, "input.requested", { requests: [approval("sig2")] }, 3000);
    expect(loadAttention(tdb).signature).not.toBe(afterAsk);

    emit(id, "input.resolved", { resolutions: [{ requestId: "sig1", outcome: "approved" }, { requestId: "sig2", outcome: "approved" }] }, 4000);
    markSeen(tdb, id, 5000);
    expect(loadAttention(tdb).signature).toBe(base);
  });
});
