import { describe, expect, it } from "vitest";
import { resultText } from "../workflows/chat/harness-call";

/**
 * 0040 phase 3: the harness call's result is the LAST step's text, not
 * every step's text joined — unless the very last step produced none,
 * in which case the last step that did is used, flagged as such.
 */

describe("resultText", () => {
  it("the last step's own text, verbatim, when it is the one that ended the call", () => {
    expect(resultText("Done: fixed the bug.", true)).toBe("Done: fixed the bug.");
  });

  it("prefixes a note when the final step had no text but an earlier one did", () => {
    expect(resultText("Now let's look at the test file…", false)).toBe(
      "(final step had no text; last text was:)\n\nNow let's look at the test file…",
    );
  });

  it("empty when no step ever produced any text", () => {
    expect(resultText("", false)).toBe("");
    expect(resultText("", true)).toBe("");
  });
});
