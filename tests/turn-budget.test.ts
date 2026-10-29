import { describe, expect, it } from "vitest";
import { resolveMaxSteps } from "../workflows/chat/turn";

/**
 * 0040 phase 3 / 0088: a start_thread child (hasParent) gets the 800-step
 * thread budget so a follow-up thread cannot run out at the plain-chat
 * 100 (workflows/chat/turn.ts wires `hasParent` into this). Skills no
 * longer matter — they never bind. The override is test-only and only
 * applies on the thread budget — a plain chat's 100 is never adjustable.
 */

describe("resolveMaxSteps", () => {
  it("a parentless chat keeps the plain 100-step budget", () => {
    expect(resolveMaxSteps(false)).toBe(100);
  });

  it("a thread child gets the 800-step background budget", () => {
    expect(resolveMaxSteps(true)).toBe(800);
  });

  it("the test override only applies to the thread budget", () => {
    expect(resolveMaxSteps(true, 2)).toBe(2);
    expect(resolveMaxSteps(false, 2)).toBe(100);
  });
});
