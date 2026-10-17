import { describe, expect, it } from "vitest";
import { resolveMaxSteps } from "../workflows/chat/turn";

/**
 * 0040 phase 3: a start_thread child gets the thread-skill step budget
 * (400) even with no skill bound, so a follow-up thread cannot run out
 * at the plain-chat 50 (workflows/chat/turn.ts wires `skill ||
 * hasParent` into this). The override is test-only and only applies on
 * the thread budget — a plain chat's 50 is never adjustable.
 */

describe("resolveMaxSteps", () => {
  it("a parentless, skill-less chat keeps the plain 50-step budget", () => {
    expect(resolveMaxSteps(false)).toBe(50);
  });

  it("a skill or a thread child gets the 400-step background budget", () => {
    expect(resolveMaxSteps(true)).toBe(400);
  });

  it("the test override only applies to the thread budget", () => {
    expect(resolveMaxSteps(true, 2)).toBe(2);
    expect(resolveMaxSteps(false, 2)).toBe(50);
  });
});
