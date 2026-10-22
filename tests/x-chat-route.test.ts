import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { db } from "../db";
import { ensureConversation, getConversation, setActiveRun } from "../db/chat";
import { messages as messagesTable } from "../db/schema";
import { GET as getChat, POST as postChat } from "../app/api/x/chat/route";

/**
 * The chat route's request validation — paths that reject BEFORE any
 * conversation row is created or a turn starts (so no workflow runs) —
 * plus the 0075 GET paging/context params, plus the POST stream shape
 * (0076 followup to #19: a fresh send streams the run's journal, a
 * steered send returns the empty finished stream).
 */

// The stream-shape tests below need a run without driving a real
// workflow: `getRun` answers a canned status/journal, `startChatTurn`
// resolves a canned runId. Nothing else in this file reaches either
// (the validation paths reject first; GET never asks).
const { getRunMock, getReadableMock, startChatTurnMock } = vi.hoisted(() => ({
  getRunMock: vi.fn(),
  getReadableMock: vi.fn(),
  startChatTurnMock: vi.fn(),
}));
vi.mock("workflow/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("workflow/api")>();
  return { ...actual, getRun: (runId: string) => getRunMock(runId) };
});
vi.mock("../lib/chat/start-turn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chat/start-turn")>();
  return {
    ...actual,
    startChatTurn: (...args: Parameters<typeof actual.startChatTurn>) => startChatTurnMock(...args),
  };
});

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

describe("POST /api/x/chat stream shape (0076 followup to #19)", () => {
  /** Parse a UI message stream response's SSE body into its parts. */
  async function sseParts(res: Response): Promise<{ type: string; delta?: string }[]> {
    return (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(5).trim()) as { type: string; delta?: string });
  }

  /** A transport send (`messages`, no explicit `text`) — wantsStream. */
  const sendStream = (conversationId: string, text: string) =>
    postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({
          conversationId,
          messages: [{ role: "user", parts: [{ type: "text", text }] }],
        }),
      }),
    );

  beforeEach(() => {
    vi.clearAllMocks();
    // Default run shape: a live status (the sweep keeps the active row),
    // a journal nobody reads unless the fresh path pipes it.
    getRunMock.mockImplementation(() => ({ status: "running", getReadable: getReadableMock }));
  });

  it("a steered send returns the empty finished stream, never the run's journal", async () => {
    ensureConversation(db(), "c_steer_stream");
    setActiveRun(db(), "c_steer_stream", "run_live_1");

    const res = await sendStream("c_steer_stream", "steer it");
    expect(res.headers.get("x-workflow-run-id")).toBe("run_live_1");
    // The status was checked (the sweep), but the journal is never
    // attached — no replay under the steer.
    expect(getRunMock).toHaveBeenCalledWith("run_live_1");
    expect(getReadableMock).not.toHaveBeenCalled();
    // Exactly start + finish: instant settle, no data parts.
    expect((await sseParts(res)).map((p) => p.type)).toEqual(["start", "finish"]);
  });

  it("a fresh send streams the run's journal from chunk 0", async () => {
    ensureConversation(db(), "c_fresh_stream");
    startChatTurnMock.mockResolvedValue({ runId: "run_fresh_1" });
    getReadableMock.mockReturnValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", text: "fresh-turn-text" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.close();
        },
      }),
    );

    const res = await sendStream("c_fresh_stream", "begin");
    expect(res.headers.get("x-workflow-run-id")).toBe("run_fresh_1");
    // The run's readable stream, replayed from the start.
    expect(getReadableMock).toHaveBeenCalledWith({ startIndex: 0 });
    const parts = await sseParts(res);
    expect(parts.map((p) => p.type)).toContain("text-delta");
    expect(parts.find((p) => p.type === "text-delta")?.delta).toBe("fresh-turn-text");
    expect(parts.at(-1)?.type).toBe("finish");
  });
});
