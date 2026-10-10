import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { appendMessages, ensureConversation, getConversation, setConversationPlaybook } from "../db/chat";
import { conversations, messages } from "../db/schema";
import { listPlaybooks, readPlaybook } from "../lib/playbooks";
import { CONTINUE_TEXT, MAX_CONTINUATIONS, continueAfterBudget, continuationsSinceHuman } from "../lib/chat/budget";
import { POST as postChat } from "../app/api/x/chat/route";

/**
 * 0037 phase 2: playbooks (markdown runbooks bound to a thread) and the
 * bounded budget continuation of a playbook turn.
 */

const ids: string[] = [];
function conv(name: string) {
  const id = `c_test_pb_${name}_${Math.random().toString(36).slice(2, 8)}`;
  ensureConversation(db(), id);
  ids.push(id);
  return id;
}

afterAll(() => {
  for (const id of ids) {
    db().delete(messages).where(eq(messages.conversationId, id)).run();
    db().delete(conversations).where(eq(conversations.id, id)).run();
  }
});

describe("playbook files", () => {
  it("ship parses: title from the H1, description from front matter, body without it", async () => {
    const ship = await readPlaybook("ship");
    expect(ship?.title).toMatch(/^Ship/);
    expect(ship?.description).toMatch(/PR/);
    expect(ship?.body.startsWith("# Ship")).toBe(true);
    expect(ship?.body).toContain("create_pr");
    expect((await listPlaybooks()).map((b) => b.id)).toContain("ship");
  });

  it("rejects traversal and unknown ids", async () => {
    for (const bad of ["../machines", "nope", "Ship", ""]) expect(await readPlaybook(bad)).toBeNull();
  });
});

describe("budget continuation", () => {
  const chip = (id: string, n: number, kind: "budget" | "harness") =>
    appendMessages(db(), id, [
      {
        id: `${id}_w${n}`,
        role: "user",
        text: "wake",
        modelMessage: { role: "user", content: "wake" },
        metadata: { runEvent: { kind, id: "x", status: "s" } },
      },
    ]);
  const human = (id: string, n: number) =>
    appendMessages(db(), id, [{ id: `${id}_h${n}`, role: "user", text: "hi", modelMessage: { role: "user", content: "hi" } }]);

  it("counts budget wakes since Chad's last message, ignoring other wakes", () => {
    const id = conv("count");
    chip(id, 1, "budget");
    human(id, 2);
    chip(id, 3, "budget");
    chip(id, 4, "harness");
    chip(id, 5, "budget");
    expect(continuationsSinceHuman(id)).toBe(2);
  });

  it("continues until the bound, then stops", async () => {
    const id = conv("bound");
    const started: string[] = [];
    const start = async (_id: string, text: string) => void started.push(text);
    expect(await continueAfterBudget(id, { start })).toBe("continued");
    expect(started).toEqual([CONTINUE_TEXT]);
    for (let i = 0; i < MAX_CONTINUATIONS; i += 1) chip(id, 10 + i, "budget");
    expect(await continueAfterBudget(id, { start })).toBe("bounded");
    expect(started).toHaveLength(1);
  });
});

describe("chat route playbook binding", () => {
  it("rejects an unknown playbook before creating anything", async () => {
    const id = `c_test_pb_bad_${Math.random().toString(36).slice(2, 8)}`;
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "hi", playbook: "nope" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(getConversation(db(), id)).toBeNull();
  });

  it("stores the thread's playbook", () => {
    const id = conv("store");
    setConversationPlaybook(db(), id, "ship");
    expect(getConversation(db(), id)?.playbook).toBe("ship");
  });
});
