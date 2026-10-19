import { describe, expect, it } from "vitest";
import { isSettled, pollSettled } from "../lib/use-pr-states";

/**
 * 0052 — the polling hook's stop rule. The hook itself is browser-bound
 * (fetch, document.visibility); the rule it consults is pure and covered
 * here: a settled PR (merged/closed) is never refetched, unknown (null)
 * keeps polling, and polling stops only once every tracked URL is
 * settled.
 */
describe("usePRStates stop rule (0052)", () => {
  it("a PR is settled only once merged or closed", () => {
    expect(isSettled(null)).toBe(false);
    expect(isSettled(undefined)).toBe(false);
    expect(isSettled({ state: "open" })).toBe(false);
    expect(isSettled({ state: "merged", mergedAt: "t" })).toBe(true);
    expect(isSettled({ state: "closed" })).toBe(true);
  });

  it("polling stops only when every tracked PR is settled", () => {
    expect(pollSettled([])).toBe(false);
    expect(pollSettled([null])).toBe(false);
    expect(pollSettled([{ state: "open" }, { state: "merged" }])).toBe(false);
    expect(pollSettled([{ state: "closed" }])).toBe(true);
    expect(pollSettled([{ state: "merged", mergedAt: "t" }, { state: "closed" }])).toBe(true);
  });
});
