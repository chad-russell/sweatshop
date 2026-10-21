import { describe, expect, it } from "vitest";
import { resolveMaxSteps } from "../workflows/chat/turn";

/**
 * 0040 phase 3: a start_thread child gets the thread-skill step budget
 * (800) even with no skill bound, so a follow-up thread cannot run out
 * at the plain-chat 100 (workflows/chat/turn.ts wires `skill ||
 * hasParent` into this). The override is test-only and only applies on
 * the thread budget — a plain chat's 100 is never adjustable.
 */

describe("resolveMaxSteps", () => {
  it("a parentless, skill-less chat keeps the plain 100-step budget", () => {
    expect(resolveMaxSteps(false)).toBe(100);
  });

  it("a skill or a thread child gets the 800-step background budget", () => {
    expect(resolveMaxSteps(true)).toBe(800);
  });

  it("the test override only applies to the thread budget", () => {
    expect(resolveMaxSteps(true, 2)).toBe(2);
    expect(resolveMaxSteps(false, 2)).toBe(100);
  });
});
