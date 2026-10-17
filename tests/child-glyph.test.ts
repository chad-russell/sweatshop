import { describe, expect, it } from "vitest";
import { childGlyphKind } from "../lib/child-glyph";

const row = (o: Partial<Parameters<typeof childGlyphKind>[0]>) => ({
  kind: "chat",
  runStatus: null,
  parentConversationId: null,
  activeRunId: null,
  threadStatus: null,
  ...o,
});

/** 0046: status glyphs for child rows in the conversation tree. */
describe("childGlyphKind", () => {
  it("harness calls: spinner, harness mark when done, ✕, ⊘", () => {
    const h = (runStatus: string) => childGlyphKind(row({ kind: "harness", runStatus, parentConversationId: "c" }));
    expect(h("running")).toBe("running");
    expect(h("completed")).toBe("harness-done");
    expect(h("failed")).toBe("failed");
    expect(h("cancelled")).toBe("cancelled");
  });

  it("child threads: spinner while live, ⚠ when exhausted, else the agent mark", () => {
    expect(childGlyphKind(row({ parentConversationId: "p", activeRunId: "w" }))).toBe("running");
    expect(childGlyphKind(row({ parentConversationId: "p", activeRunId: "w", threadStatus: "exhausted" }))).toBe("running");
    expect(childGlyphKind(row({ parentConversationId: "p", threadStatus: "exhausted" }))).toBe("needs-attention");
    expect(childGlyphKind(row({ parentConversationId: "p" }))).toBe("agent-done");
  });

  it("top-level chats and historical runs get nothing here", () => {
    expect(childGlyphKind(row({}))).toBe("none");
    expect(childGlyphKind(row({ activeRunId: "w" }))).toBe("none");
    expect(childGlyphKind(row({ kind: "run", runStatus: "completed", parentConversationId: "p" }))).toBe("none");
  });
});
