import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { rowsToUIMessages, type StoredRow } from "../lib/chat-ui";

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
});
