import { describe, expect, it } from "vitest";
import { conversationHref } from "../lib/conversation-href";

/** 0012 + 0046: where a sidebar row opens. */
describe("conversationHref", () => {
  it("opens a chat at /c/<id>, defaulting to the chat kind", () => {
    expect(conversationHref({ id: "wrun_1" })).toBe("/c/wrun_1");
    expect(conversationHref({ id: "wrun_2", kind: "chat" })).toBe("/c/wrun_2");
    expect(conversationHref({ id: "wrun_3", kind: null })).toBe("/c/wrun_3");
  });

  it("opens a run conversation at /r/<run id>", () => {
    expect(conversationHref({ id: "mr_1", kind: "run" })).toBe("/r/mr_1");
  });

  it("opens a synthetic harness row at its session URL (0046)", () => {
    expect(
      conversationHref({ id: "hc_1", kind: "harness", harness: "pi", parentConversationId: "wrun_1" }),
    ).toBe("/h/pi/wrun_1");
    expect(
      conversationHref({ id: "hc_2", kind: "harness", harness: "claude", parentConversationId: "wrun_9" }),
    ).toBe("/h/claude/wrun_9");
  });
});
