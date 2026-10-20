import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { ensureConversation, getConversation } from "../db/chat";
import { conversations, messages } from "../db/schema";
import { publishEdit } from "../db/prompt-settings";
import { listThreadSkills, readSkill } from "../lib/skills";
import { startThread } from "../lib/agent/tools/start-thread";
import { POST as postChat } from "../app/api/x/chat/route";

/**
 * 0054 hardening (3): binding a skill to a BRAND NEW conversation or
 * child thread must only accept an active, thread-bindable skill —
 * `readSkill` deliberately also resolves a disabled/deleted one (so an
 * ALREADY-bound thread keeps running it), which made it the wrong
 * existence check for a new bind. Both call sites
 * (app/api/x/chat/route.ts, lib/agent/tools/start-thread.ts) now check
 * `listThreadSkills()` instead.
 */

const ids: string[] = [];
function freshId(label: string) {
  const id = `c_test_skbind_${label}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  return id;
}

afterAll(() => {
  for (const id of ids) {
    db().delete(messages).where(eq(messages.conversationId, id)).run();
    db().delete(conversations).where(eq(conversations.id, id)).run();
  }
});

/** A fresh thread skill fixture, created active then moved to the
 *  requested status — independent of the shipped ship/ticket/review
 *  skills (each test file gets its own temp db, but a dedicated fixture
 *  keeps intent obvious either way). */
function makeSkill(id: string, status: "active" | "disabled" | "deleted") {
  const created = publishEdit(db(), { kind: "skill", id }, {
    patch: { body: `# ${id}`, thread: true, status: "active" },
    expectedVersion: 0,
  });
  if (!created.ok) throw new Error(`fixture setup failed: ${JSON.stringify(created)}`);
  if (status !== "active") {
    const changed = publishEdit(db(), { kind: "skill", id }, { patch: { status }, expectedVersion: created.version });
    if (!changed.ok) throw new Error(`fixture status change failed: ${JSON.stringify(changed)}`);
  }
}

describe("POST /api/x/chat: a new conversation only binds an active thread skill", () => {
  it("rejects a disabled skill and a deleted skill before creating anything", async () => {
    const disabledId = `skb-disabled-${Math.random().toString(36).slice(2, 8)}`;
    const deletedId = `skb-deleted-${Math.random().toString(36).slice(2, 8)}`;
    makeSkill(disabledId, "disabled");
    makeSkill(deletedId, "deleted");

    for (const skill of [disabledId, deletedId]) {
      const id = freshId(skill);
      const res = await postChat(
        new Request("http://x/api/x/chat", { method: "POST", body: JSON.stringify({ conversationId: id, text: "hi", skill }) }),
      );
      expect(res.status).toBe(400);
      expect(getConversation(db(), id)).toBeNull();
    }
  });

  it("reference: an active, shipped thread skill still binds (regression guard)", async () => {
    const id = freshId("ref-review");
    const res = await postChat(
      new Request("http://x/api/x/chat", { method: "POST", body: JSON.stringify({ conversationId: id, text: "hi", skill: "review" }) }),
    );
    expect(res.status).toBe(200);
    expect(getConversation(db(), id)?.skill).toBe("review");
  });
});

describe("start_thread: a new child only binds an active thread skill", () => {
  it("rejects a disabled skill and a deleted skill", async () => {
    const parent = freshId("parent-reject");
    ensureConversation(db(), parent);
    const disabledId = `skbt-disabled-${Math.random().toString(36).slice(2, 8)}`;
    const deletedId = `skbt-deleted-${Math.random().toString(36).slice(2, 8)}`;
    makeSkill(disabledId, "disabled");
    makeSkill(deletedId, "deleted");

    for (const skill of [disabledId, deletedId]) {
      const result = await startThread({
        conversationId: parent,
        prompt: "look",
        skill,
        fresh: true,
        start: async () => ({ runId: "wr_never" }),
      });
      expect(result).toMatchObject({ ok: false, code: "no-skill" });
    }
  });

  it("reference: an active, shipped thread skill still binds (regression guard)", async () => {
    const parent = freshId("parent-accept");
    ensureConversation(db(), parent);
    const result = await startThread({
      conversationId: parent,
      prompt: "look",
      skill: "review",
      fresh: true,
      start: async () => ({ runId: "wr_ok" }),
    });
    expect(result).toMatchObject({ ok: true, skill: "review" });
    if (result.ok) ids.push(result.id);
  });

  it("contrast: readSkill (the already-bound-thread lookup) still resolves a disabled skill — only the new-bind catalog hides it", async () => {
    const id = `skbt-contrast-${Math.random().toString(36).slice(2, 8)}`;
    makeSkill(id, "disabled");
    expect((await readSkill(id))?.id).toBe(id);
    expect((await listThreadSkills()).some((s) => s.id === id)).toBe(false);
  });
});
