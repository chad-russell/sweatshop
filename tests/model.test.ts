import { describe, expect, it } from "vitest";
import {
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  findChatModel,
  resolveChatModel,
} from "../lib/model";

describe("chat model table", () => {
  it("has unique endpoint ids", () => {
    const ids = CHAT_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every model carries a usable context window for compaction", () => {
    for (const model of CHAT_MODELS) {
      expect(model.contextWindowTokens).toBeGreaterThan(0);
      expect(model.label).toBeTruthy();
      expect(model.description).toBeTruthy();
    }
  });
});

describe("resolveChatModel", () => {
  it("resolves a known id to its model", () => {
    expect(resolveChatModel("glm-5.3").id).toBe("glm-5.3");
  });

  it("falls back to the default on unknown or missing ids", () => {
    // The picker only offers known ids; a miss means a stale client or a
    // hand-crafted header — never a reason to fail the turn.
    expect(resolveChatModel("glm-9.9-nonsense")).toBe(DEFAULT_CHAT_MODEL);
    expect(resolveChatModel("")).toBe(DEFAULT_CHAT_MODEL);
    expect(resolveChatModel(null)).toBe(DEFAULT_CHAT_MODEL);
    expect(resolveChatModel(undefined)).toBe(DEFAULT_CHAT_MODEL);
  });

  it("findChatModel distinguishes known from unknown", () => {
    expect(findChatModel(DEFAULT_CHAT_MODEL.id)?.id).toBe(
      DEFAULT_CHAT_MODEL.id,
    );
    expect(findChatModel("nope")).toBeUndefined();
  });
});
