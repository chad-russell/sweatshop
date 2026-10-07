import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { hasBackgroundChild, rowsToUIMessages, type StoredRow } from "../lib/chat-ui";
import { parseViewingContext, viewingNote } from "../lib/page-context";

let n = 0;
const row = (modelMessage: ModelMessage): StoredRow => {
  n += 1;
  return { id: `m${n}`, role: modelMessage.role, text: "flat", at: 1000 + n, modelMessage };
};

describe("rowsToUIMessages", () => {
  it("folds assistant/tool/assistant rows into one message with settled tool parts", () => {
    const ui = rowsToUIMessages([
      row({ role: "user", content: "run pi" }),
      row({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "pi", input: { task: "ls" } }],
      }),
      row({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "pi",
            output: { type: "error-text", value: "boom" },
          },
        ],
      }),
      row({
        role: "assistant",
        content: [
          { type: "text", text: "failed" },
          { type: "tool-call", toolCallId: "c2", toolName: "bash", input: { command: "ls" } },
        ],
      }),
      row({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "bash",
            output: { type: "json", value: { stdout: "a" } },
          },
        ],
      }),
      row({ role: "assistant", content: [{ type: "text", text: "done" }] }),
    ]);

    expect(ui.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(ui[1].parts).toMatchObject([
      { type: "tool-pi", state: "output-error", errorText: "boom", input: { task: "ls" } },
      { type: "text", text: "failed" },
      { type: "tool-bash", state: "output-available", output: { stdout: "a" } },
      { type: "text", text: "done" },
    ]);
  });

  it("starts a new assistant message after each user message", () => {
    const ui = rowsToUIMessages([
      row({ role: "user", content: "a" }),
      row({ role: "assistant", content: "b" }),
      row({ role: "user", content: "c" }),
      row({ role: "assistant", content: "d" }),
    ]);
    expect(ui.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("keeps text-only legacy rows without a model message", () => {
    const ui = rowsToUIMessages([
      { id: "x", role: "assistant", text: "old", at: 1, modelMessage: null },
    ]);
    expect(ui[0].parts).toEqual([{ type: "text", text: "old" }]);
  });

  it("carries a user row's viewing context as message metadata (0015)", () => {
    const ui = rowsToUIMessages([
      { id: "v1", role: "user", text: "this?", at: 1, modelMessage: { role: "user", content: "this?" }, metadata: { viewing: { kind: "machine", id: "ticket", selection: "stage verify" } } },
      { id: "v2", role: "assistant", text: "ok", at: 2, modelMessage: { role: "assistant", content: "ok" } },
      { id: "v3", role: "user", text: "plain", at: 3, modelMessage: { role: "user", content: "plain" } },
    ]);
    expect(ui[0].metadata).toMatchObject({ viewing: { kind: "machine", id: "ticket" } });
    expect(ui[2].metadata).not.toHaveProperty("viewing");
  });

  it("carries a wake row's runEvent so it renders as a chip, not Chad's words (0022)", () => {
    const runEvent = { kind: "harness" as const, id: "hc_1", status: "completed" };
    const ui = rowsToUIMessages([
      { id: "w1", role: "user", text: "[pi finished] — /h/pi/c", at: 1, modelMessage: { role: "user", content: "[pi finished] — /h/pi/c" }, metadata: { runEvent } },
    ]);
    expect(ui[0].metadata).toMatchObject({ runEvent });
  });
});

describe("viewing note (0015)", () => {

  it("names what Chad is viewing, the details, and the fetch tool", () => {
    const note = viewingNote({
      kind: "machine",
      id: "ticket",
      title: "Ticket",
      selection: "stage verify",
      path: "/machines/ticket",
    });
    expect(note.startsWith("[viewing] Chad is viewing machine \"Ticket\" (`ticket`)")).toBe(true);
    expect(note).toContain("at /machines/ticket");
    expect(note).toContain("selected: stage verify");
    expect(note).toContain("get_machine");
  });

  it("run contexts point at inspect and carry status", () => {
    const note = viewingNote({ kind: "run", id: "mr_1", runStatus: "waiting", currentStage: "approve" });
    expect(note).toContain("status: waiting");
    expect(note).toContain("current stage: approve");
    expect(note).toContain("inspect");
  });

  it("accepts only the known shape", () => {
    expect(parseViewingContext({ kind: "chat", id: "c_1" })).toEqual({ kind: "chat", id: "c_1" });
    expect(parseViewingContext({ kind: "nope" })).toBeNull();
    expect(parseViewingContext({ kind: "chat", extra: true })).toBeNull();
    expect(parseViewingContext(null)).toBeNull();
  });
});

describe("hasBackgroundChild (0022 wake watch)", () => {
  const started = (tool: string, output: unknown): import("ai").UIMessage => ({
    id: `a_${tool}`,
    role: "assistant",
    parts: [{ type: `tool-${tool}`, toolCallId: "t", state: "output-available", input: {}, output } as never],
  });
  const wake: import("ai").UIMessage = { id: "w", role: "user", parts: [{ type: "text", text: "[pi finished]" }], metadata: { runEvent: { kind: "harness", id: "hc_1", status: "completed" } } };

  it("is true while a started run or harness call has not woken the chat yet", () => {
    expect(hasBackgroundChild([started("pi", { ok: true, callId: "hc_1" })])).toBe(true);
    expect(hasBackgroundChild([started("start_machine", { runId: "mr_1", url: "/r/mr_1" })])).toBe(true);
  });
  it("is false with nothing started, a listing, a failed start, or after the wake", () => {
    expect(hasBackgroundChild([])).toBe(false);
    expect(hasBackgroundChild([started("start_machine", { machines: [] })])).toBe(false);
    expect(hasBackgroundChild([started("pi", { ok: false, code: "busy" })])).toBe(false);
    expect(hasBackgroundChild([started("pi", { ok: true, callId: "hc_1" }), wake])).toBe(false);
  });
});
