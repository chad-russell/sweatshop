import { describe, expect, it } from "vitest";
import { db } from "../db";
import { getConversation } from "../db/chat";
import { POST as postChat } from "../app/api/x/chat/route";

/**
 * The chat route's request validation — paths that reject BEFORE any
 * conversation row is created or a turn starts (so no workflow runs).
 */

const send = (body: unknown) =>
  postChat(new Request("http://x/api/x/chat", { method: "POST", body: JSON.stringify(body) }));

describe("POST /api/x/chat validation", () => {
  it("rejects an unknown project with 404 instead of crashing on the foreign key", async () => {
    const res = await send({ conversationId: "c_badproj_1", projectId: "no-such-project", text: "hi" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("no-such-project");
    // Nothing was created.
    expect(getConversation(db(), "c_badproj_1")).toBeNull();
  });

  it("rejects a non-string projectId with 400", async () => {
    const res = await send({ conversationId: "c_badproj_2", projectId: 42, text: "hi" });
    expect(res.status).toBe(400);
    expect(getConversation(db(), "c_badproj_2")).toBeNull();
  });
});
