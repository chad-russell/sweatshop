import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { db } from "../db";
import { ensureConversation, getConversation } from "../db/chat";
import { messages as messagesTable } from "../db/schema";
import { GET as getChat, POST as postChat } from "../app/api/x/chat/route";

/**
 * The chat route's request validation — paths that reject BEFORE any
 * conversation row is created or a turn starts (so no workflow runs) —
 * plus the 0075 GET paging/context params.
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

/** Insert raw rows (rowid = insertion order) with exact modelMessages. */
function seedRows(conversationId: string, rows: { role: string; text: string; modelMessage: ModelMessage | null }[]) {
  ensureConversation(db(), conversationId);
  let at = 1000;
  for (const [i, row] of rows.entries()) {
    db()
      .insert(messagesTable)
      .values({
        id: `${conversationId}_${i + 1}`,
        conversationId,
        role: row.role,
        text: row.text,
        modelMessage: row.modelMessage == null ? null : JSON.stringify(row.modelMessage),
        at: ++at,
      })
      .run();
  }
}

/** An assistant tool-call row followed by its tool-result row — the pair
 *  rowsToUIMessages folds into one tool part. */
function toolPair(toolCallId: string, toolName: string, input: object, output: object) {
  return [
    {
      role: "assistant",
      text: `[${toolName}]`,
      modelMessage: {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId, toolName, input }],
      } as unknown as ModelMessage,
    },
    {
      role: "tool",
      text: "",
      modelMessage: {
        role: "tool",
        content: [{ type: "tool-result", toolCallId, toolName, output: { type: "json", value: output } }],
      } as unknown as ModelMessage,
    },
  ];
}

const get = (query: string) => getChat(new Request(`http://x/api/x/chat?${query}`));

describe("GET /api/x/chat paging", () => {
  it("without params returns today's exact shape and full content", async () => {
    seedRows("c_page1", [
      { role: "user", text: "one", modelMessage: { role: "user", content: "one" } },
      { role: "assistant", text: "two", modelMessage: { role: "assistant", content: "two" } },
      { role: "user", text: "three", modelMessage: { role: "user", content: "three" } },
    ]);
    const res = await get("conversationId=c_page1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Shape: exactly the keys the chat surface has always consumed.
    expect(Object.keys(body).sort()).toEqual(["activeRunId", "messages", "projectId", "route", "sandbox", "title"]);
    const messages = body.messages as { id: string }[];
    expect(messages.map((m) => m.id)).toEqual(["c_page1_1", "c_page1_2", "c_page1_3"]);
  });

  it("tail returns the newest rows plus olderCursor/olderRemaining", async () => {
    seedRows(
      "c_page2",
      Array.from({ length: 5 }, (_, i) => ({
        role: "user",
        text: `m${i}`,
        modelMessage: { role: "user", content: `m${i}` } as ModelMessage,
      })),
    );
    const res = await get("conversationId=c_page2&tail=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { id: string }[]; olderCursor: number; olderRemaining: number };
    expect(body.messages.map((m) => m.id)).toEqual(["c_page2_4", "c_page2_5"]);
    expect(body.olderRemaining).toBe(3);
    expect(body.olderCursor).toBeGreaterThan(0);
    // Paging before the cursor chains towards the start.
    const prev = await get(`conversationId=c_page2&tail=2&before=${body.olderCursor}`);
    const prevBody = (await prev.json()) as { messages: { id: string }[]; olderRemaining: number };
    expect(prevBody.messages.map((m) => m.id)).toEqual(["c_page2_2", "c_page2_3"]);
    expect(prevBody.olderRemaining).toBe(1);
  });

  it("rejects invalid tail/before with 400", async () => {
    for (const query of [
      "conversationId=c_page3&tail=0",
      "conversationId=c_page3&tail=-5",
      "conversationId=c_page3&tail=abc",
      "conversationId=c_page3&tail=1001",
      "conversationId=c_page3&before=abc",
      "conversationId=c_page3&before=0",
    ]) {
      const res = await get(query);
      expect(res.status, query).toBe(400);
    }
  });
});

describe("GET /api/x/chat context", () => {
  it("context=1 derives the header facts from the WHOLE transcript", async () => {
    seedRows("c_ctx1", [
      { role: "user", text: "build it", modelMessage: { role: "user", content: "build it" } },
      ...toolPair("oc1", "update_outline", {}, { ok: true, outline: { goal: "g", steps: [] } }),
      { role: "assistant", text: "outlined", modelMessage: { role: "assistant", content: "outlined" } },
    ]);
    const res = await get("conversationId=c_ctx1&context=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      context: {
        phase: { label: string } | null;
        diffBreakdown: unknown;
        hasBackgroundChild: boolean;
      };
    };
    // Outline-derived phase, no background children, no diff.
    expect(body.context.hasBackgroundChild).toBe(false);
    expect(body.context.diffBreakdown).toBeNull();
  });

  it("context=1 marks a background child so the wake watch survives a tail window", async () => {
    seedRows("c_ctx2", [
      { role: "user", text: "run pi", modelMessage: { role: "user", content: "run pi" } },
      ...toolPair("pc2", "pi", { task: "ls" }, { ok: true, callId: "hc_1" }),
    ]);
    const res = await get("conversationId=c_ctx2&context=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { context: { hasBackgroundChild: boolean } };
    expect(body.context.hasBackgroundChild).toBe(true);
  });
});
