import { describe, expect, it } from "vitest";
import { conversationLabel, placeholderToolNames } from "../lib/conversation-label";

describe("conversationLabel", () => {
  it("prefers a non-empty title", () => {
    expect(conversationLabel({ title: " Hi ", id: "c_1", firstUserText: "x" })).toBe("Hi");
  });
  it("falls back to a clipped, stripped first user message", () => {
    expect(conversationLabel({ title: "", id: "c_1", firstUserText: "## Fix **the**\n\nbug [tool exec]" })).toBe("Fix the bug");
    const long = conversationLabel({ title: null, id: "c_1", firstUserText: "a".repeat(200) });
    expect(long.length).toBe(60);
    expect(long.endsWith("…")).toBe(true);
  });
  it("falls back to Untitled chat, never the id", () => {
    expect(conversationLabel({ title: null, id: "c_1" })).toBe("Untitled chat");
    expect(conversationLabel({ title: null, id: "c_1", firstUserText: "[tool exec]" })).toBe("Untitled chat");
  });
  it("lists placeholder tool names", () => {
    expect(placeholderToolNames("[tool exec] [tool bash][tool exec]")).toEqual(["exec", "bash"]);
  });
});
