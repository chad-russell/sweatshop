import { describe, expect, it } from "vitest";
import { promptPrefill } from "../lib/prompt-prefill";

/** 0090 §6: the ?prompt= handoff — parsed, capped, never auto-sent. */
describe("promptPrefill (0090 §6)", () => {
  it("takes a string through, trimming whitespace", () => {
    expect(promptPrefill("  Write a skill for PDFs  ")).toBe("Write a skill for PDFs");
  });

  it("rejects non-strings and empty text", () => {
    expect(promptPrefill(undefined)).toBeUndefined();
    expect(promptPrefill(7)).toBeUndefined();
    expect(promptPrefill("   ")).toBeUndefined();
  });

  it("caps at 2000 characters", () => {
    expect(promptPrefill("x".repeat(3000))).toBe("x".repeat(2000));
  });
});
