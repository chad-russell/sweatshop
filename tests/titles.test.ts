import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../db";
import { renameConversation } from "../db/organize";
import { conversations, messages } from "../db/schema";
import {
  REGENERATE_AT_USER_MESSAGES,
  maybeGenerateTitle,
  parseGeneratedMeta,
} from "../lib/titles";

const tdb = openDb(process.env.SWEATSHOP_DB!);

let n = 0;
function convo(userMessages: number, assistantMessages: number) {
  n += 1;
  const id = `wrun_title_${n}`;
  tdb.insert(conversations).values({ id, title: "first message", createdAt: 1, updatedAt: 1 }).run();
  let at = 0;
  const add = (role: "user" | "assistant", i: number) => {
    at += 1;
    tdb.insert(messages).values({ id: `evt_${id}_${role}_${i}`, conversationId: id, role, text: `${role} ${i}`, at }).run();
  };
  for (let i = 0; i < userMessages; i += 1) add("user", i);
  for (let i = 0; i < assistantMessages; i += 1) add("assistant", i);
  return id;
}
const row = (id: string) => tdb.select().from(conversations).where(eq(conversations.id, id)).get()!;
const REPLY = "TITLE: Sandbox spike notes\nSUMMARY: Explored podman sandboxes.";

describe("parseGeneratedMeta", () => {
  it("parses both lines, strips quotes and trailing period", () => {
    expect(parseGeneratedMeta('TITLE: "Fixing the sidebar."\nSUMMARY: Reworked it.')).toEqual({
      title: "Fixing the sidebar",
      summary: "Reworked it.",
    });
  });
  it("tolerates case, extra whitespace and a missing summary", () => {
    expect(parseGeneratedMeta("  title :   Short one  ")).toEqual({ title: "Short one", summary: "" });
  });
  it("returns null without a title and clips overlong ones", () => {
    expect(parseGeneratedMeta("no labels here")).toBeNull();
    expect(parseGeneratedMeta(`TITLE: ${"w ".repeat(100)}`)!.title.length).toBeLessThanOrEqual(60);
  });
});

describe("maybeGenerateTitle", () => {
  it("writes title + summary after the first assistant reply", async () => {
    const id = convo(1, 1);
    const generate = vi.fn().mockResolvedValue(REPLY);
    const meta = await maybeGenerateTitle(id, { db: tdb, generate });
    expect(meta?.title).toBe("Sandbox spike notes");
    expect(row(id)).toMatchObject({
      title: "Sandbox spike notes",
      summary: "Explored podman sandboxes.",
      titleGenerations: 1,
      titleSource: "auto",
    });
    expect(generate.mock.calls[0][0]).toContain("User: user 0");
  });

  it("does nothing before there is an assistant reply or a user message", async () => {
    const generate = vi.fn().mockResolvedValue(REPLY);
    expect(await maybeGenerateTitle(convo(1, 0), { db: tdb, generate })).toBeNull();
    expect(await maybeGenerateTitle(convo(0, 1), { db: tdb, generate })).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("never overwrites a manual rename", async () => {
    const id = convo(1, 1);
    renameConversation(tdb, id, "My own title");
    const generate = vi.fn().mockResolvedValue(REPLY);
    expect(await maybeGenerateTitle(id, { db: tdb, generate })).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(row(id).title).toBe("My own title");
  });

  it("regenerates exactly once more at the threshold, then stops", async () => {
    const id = convo(1, 1);
    const generate = vi.fn().mockResolvedValue(REPLY);
    await maybeGenerateTitle(id, { db: tdb, generate });
    // Not due again until the conversation has grown.
    expect(await maybeGenerateTitle(id, { db: tdb, generate })).toBeNull();
    for (let i = 1; i < REGENERATE_AT_USER_MESSAGES; i += 1) {
      tdb.insert(messages).values({ id: `evt_${id}_more_${i}`, conversationId: id, role: "user", text: `more ${i}`, at: 100 + i }).run();
    }
    generate.mockResolvedValue("TITLE: Later topic\nSUMMARY: It drifted.");
    expect((await maybeGenerateTitle(id, { db: tdb, generate }))?.title).toBe("Later topic");
    expect(row(id).titleGenerations).toBe(2);
    expect(await maybeGenerateTitle(id, { db: tdb, generate })).toBeNull();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("gives the slot back when the model fails or returns junk", async () => {
    const id = convo(1, 1);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await maybeGenerateTitle(id, { db: tdb, generate: () => Promise.reject(new Error("boom")) })).toBeNull();
    expect(row(id).titleGenerations).toBe(0);
    expect(await maybeGenerateTitle(id, { db: tdb, generate: async () => "garbage" })).toBeNull();
    expect(row(id).titleGenerations).toBe(0);
    err.mockRestore();
    expect((await maybeGenerateTitle(id, { db: tdb, generate: async () => REPLY }))?.title).toBe("Sandbox spike notes");
  });

  it("does not clobber a rename that lands during generation", async () => {
    const id = convo(1, 1);
    const generate = async () => {
      renameConversation(tdb, id, "Renamed mid-flight");
      return REPLY;
    };
    expect(await maybeGenerateTitle(id, { db: tdb, generate })).toBeNull();
    expect(row(id).title).toBe("Renamed mid-flight");
  });
});
