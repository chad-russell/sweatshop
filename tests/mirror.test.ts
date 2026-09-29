import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../db";
import { conversations, conversationEvents } from "../db/schema";
import { mirrorStreamEvent, titleFromMessage } from "../db/mirror";

const tdb = openDb(process.env.SWEATSHOP_DB!);

let seq = 0;
function envelope(
  type: string,
  data?: unknown,
  id?: string,
): Parameters<typeof mirrorStreamEvent>[1] {
  seq += 1;
  return {
    type,
    data,
    meta: {
      id: id ?? `evt_test${String(seq).padStart(20, "0")}`,
      at: "2026-09-29T12:00:00.000Z",
    },
  };
}

const conv = () => `wrun_test_${++seq}`;

describe("mirrorStreamEvent", () => {
  it("creates the conversation row and mirrors the event", () => {
    const id = conv();
    mirrorStreamEvent(id, envelope("session.started"));

    const row = tdb.query.conversations.findFirst({
      where: eq(conversations.id, id),
    }).sync();
    expect(row).toMatchObject({ id, eventCount: 1 });
    expect(row?.createdAt).toBeGreaterThan(0);

    const events = tdb
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, id))
      .all();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("session.started");
    expect(JSON.parse(events[0]!.event)).toMatchObject({ type: "session.started" });
  });

  it("is idempotent on repeated event ids (meta.id is the key)", () => {
    const id = conv();
    const event = envelope("message.completed", { message: "hi" }, "evt_dedup");
    mirrorStreamEvent(id, event);
    mirrorStreamEvent(id, event);

    const events = tdb
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, id))
      .all();
    expect(events).toHaveLength(1);

    const row = tdb.query.conversations.findFirst({
      where: eq(conversations.id, id),
    }).sync();
    expect(row?.eventCount).toBe(1);
  });

  it("titles from the first user message only", () => {
    const id = conv();
    mirrorStreamEvent(id, envelope("session.started"));
    mirrorStreamEvent(id, envelope("message.received", { message: "first question" }));
    mirrorStreamEvent(id, envelope("message.received", { message: "second question" }));

    const row = tdb.query.conversations.findFirst({
      where: eq(conversations.id, id),
    }).sync();
    expect(row?.title).toBe("first question");
  });

  it("never titles from background-task input", () => {
    const id = conv();
    mirrorStreamEvent(id, envelope("message.received", {
      kind: "execution.background_task",
      message: "task input",
    }));

    const row = tdb.query.conversations.findFirst({
      where: eq(conversations.id, id),
    }).sync();
    expect(row?.title).toBeNull();
  });

  it("skips events without meta.id (pre-v20 streams cannot be deduped)", () => {
    const id = conv();
    mirrorStreamEvent(id, { type: "message.appended", data: { messageDelta: "x" } });

    const events = tdb
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, id))
      .all();
    expect(events).toHaveLength(0);
  });
});

describe("titleFromMessage", () => {
  it("collapses whitespace", () => {
    expect(titleFromMessage("  hello \n\n  world \t")).toBe("hello world");
  });

  it("truncates long messages to ~60 chars with an ellipsis", () => {
    const title = titleFromMessage("x".repeat(120));
    expect(title).toHaveLength(60);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("returns null for empty or non-string input", () => {
    expect(titleFromMessage("")).toBeNull();
    expect(titleFromMessage("   ")).toBeNull();
    expect(titleFromMessage(42)).toBeNull();
  });
});
