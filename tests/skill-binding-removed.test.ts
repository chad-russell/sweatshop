import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { getConversation } from "../db/chat";
import { conversations, messages } from "../db/schema";
import { POST as postChat } from "../app/api/x/chat/route";

/**
 * 0088: thread binding is gone. A `skill` field on a creating send is
 * simply ignored (old clients/bookmarks don't break) — the conversation
 * is created as a plain chat and nothing in the schema holds a skill.
 */

const ids: string[] = [];
afterAll(() => {
  for (const id of ids) {
    db().delete(messages).where(eq(messages.conversationId, id)).run();
    db().delete(conversations).where(eq(conversations.id, id)).run();
  }
});

describe("POST /api/x/chat: no skill binding", () => {
  it("ignores a skill field — the conversation is created plain", async () => {
    const id = `c_test_nobind_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    const res = await postChat(
      new Request("http://x/api/x/chat", { method: "POST", body: JSON.stringify({ conversationId: id, text: "hi", skill: "review" }) }),
    );
    expect(res.status).toBe(200);
    expect(getConversation(db(), id)).not.toBeNull();
    expect(getConversation(db(), id)).not.toHaveProperty("skill");
  });

  it("the conversations table has no skill column", () => {
    expect(Object.keys(conversations)).not.toContain("skill");
  });
});
