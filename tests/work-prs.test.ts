import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { classifyDiff } from "../lib/diff-breakdown";
import { applyLiveStates, mergeBreakdowns, prUrlCoords, workPRsFromMessages } from "../lib/work-prs";

/**
 * 0078: the work pill's pure core — multiple create_pr calls per
 * thread, each tracked independently, with an aggregate diff breakdown
 * across them. Mirrors tests/diff-breakdown.test.ts's `latestDiffBreakdown`
 * coverage, extended for several PRs.
 */

const breakdownA = classifyDiff([{ path: "a.ts", added: 1, deleted: 0, binary: false }]);
const breakdownB = classifyDiff([{ path: "docs/b.md", added: 2, deleted: 3, binary: false }]);

function createPrMessage(id: string, state: string, input: unknown, output?: unknown): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "tool-create_pr", toolCallId: id, state, input, ...(output !== undefined ? { output } : {}) },
    ] as UIMessage["parts"],
  };
}

describe("workPRsFromMessages", () => {
  it("returns no PRs with no create_pr calls", () => {
    expect(workPRsFromMessages([])).toEqual([]);
  });

  it("tracks a pending call awaiting approval", () => {
    const msgs = [createPrMessage("p1", "input-available", { title: "Add thing", head: "feat/x", repo: "sweatshop" })];
    expect(workPRsFromMessages(msgs)).toEqual([
      { toolCallId: "p1", state: "pending", title: "Add thing", head: "feat/x", repo: "sweatshop" },
    ]);
  });

  it("tracks multiple open PRs in transcript order", () => {
    const msgs = [
      createPrMessage("p1", "output-available", { title: "First" }, { url: "https://example.com/o/r/pull/1", number: 1, breakdown: breakdownA }),
      createPrMessage("p2", "output-available", { title: "Second" }, { url: "https://example.com/o/r/pull/2", number: 2, breakdown: breakdownB }),
    ];
    const prs = workPRsFromMessages(msgs);
    expect(prs.map((p) => p.title)).toEqual(["First", "Second"]);
    expect(prs.map((p) => p.state)).toEqual(["open", "open"]);
    expect(prs[0]?.breakdown).toEqual(breakdownA);
    expect(prs[1]?.breakdown).toEqual(breakdownB);
  });

  it("dedupes a retried open by url, newest wins, keeping the first position", () => {
    const msgs = [
      createPrMessage("p1", "output-available", { title: "Stale title" }, { url: "https://example.com/o/r/pull/1", number: 1, breakdown: breakdownA }),
      createPrMessage("p2", "output-available", { title: "Other" }, { url: "https://example.com/o/r/pull/9", number: 9 }),
      createPrMessage("p3", "output-available", { title: "Fresh title" }, { url: "https://example.com/o/r/pull/1", number: 1, breakdown: breakdownB }),
    ];
    const prs = workPRsFromMessages(msgs);
    expect(prs.map((p) => p.title)).toEqual(["Fresh title", "Other"]);
    expect(prs[0]?.breakdown).toEqual(breakdownB);
  });

  it("drops a denied/sent-back call (ok: false)", () => {
    const msgs = [
      createPrMessage("p1", "output-available", { title: "Kept" }, { url: "https://example.com/o/r/pull/1", number: 1 }),
      createPrMessage("p2", "input-available", { title: "Denied" }),
      createPrMessage("p2", "output-available", { title: "Denied" }, { ok: false, code: "denied", message: "no" }),
    ];
    expect(workPRsFromMessages(msgs).map((p) => p.title)).toEqual(["Kept"]);
  });

  it("drops an errored call", () => {
    const msgs = [
      createPrMessage("p1", "input-available", { title: "Will fail" }),
      createPrMessage("p1", "output-error", {}),
    ];
    expect(workPRsFromMessages(msgs)).toEqual([]);
  });

  it("carries an open PR with no breakdown field at all (older result)", () => {
    const msgs = [createPrMessage("p1", "output-available", { title: "Old" }, { url: "https://example.com/o/r/pull/1", number: 1 })];
    const prs = workPRsFromMessages(msgs);
    expect(prs).toHaveLength(1);
    expect(prs[0]?.breakdown).toBeUndefined();
  });
});

describe("mergeBreakdowns", () => {
  it("returns null for an empty list", () => {
    expect(mergeBreakdowns([])).toBeNull();
  });

  it("sums files/added/deleted and per-category, in fixed category order", () => {
    const merged = mergeBreakdowns([breakdownA, breakdownB]);
    expect(merged).toMatchObject({ files: 2, added: 3, deleted: 3 });
    expect(merged?.categories.map((c) => c.key)).toEqual(["docs", "code"]);
    const docs = merged?.categories.find((c) => c.key === "docs");
    expect(docs).toMatchObject({ files: 1, added: 2, deleted: 3 });
  });
});

describe("applyLiveStates", () => {
  const openPR = { toolCallId: "p1", url: "https://x/pull/1", number: 1, state: "open" as const };
  const pendingPR = { toolCallId: "p2", state: "pending" as const };

  it("marks a pending PR pending regardless of any states map", () => {
    expect(applyLiveStates([pendingPR], {})).toEqual([{ ...pendingPR, displayState: "pending" }]);
  });

  it("defaults an open PR with no known live state to open", () => {
    expect(applyLiveStates([openPR], {})).toEqual([{ ...openPR, displayState: "open" }]);
  });

  it("relabels an open PR by its host's live answer", () => {
    expect(applyLiveStates([openPR], { "https://x/pull/1": { state: "merged" } })).toEqual([
      { ...openPR, displayState: "merged" },
    ]);
    expect(applyLiveStates([openPR], { "https://x/pull/1": { state: "closed" } })).toEqual([
      { ...openPR, displayState: "closed" },
    ]);
  });
});

describe("prUrlCoords", () => {
  it("reads owner/repo and number off a PR web URL (GitHub and Forgejo pull(s) forms)", () => {
    expect(prUrlCoords("https://github.com/chad-russell/sweatshop/pull/42")).toEqual({ repo: "chad-russell/sweatshop", number: "42" });
    expect(prUrlCoords("https://git.crussell.io/chad/sweatshop/pulls/7")).toEqual({ repo: "chad/sweatshop", number: "7" });
  });

  it("returns null for an unrecognized URL shape", () => {
    expect(prUrlCoords("https://example.com/not-a-pr")).toBeNull();
  });
});
