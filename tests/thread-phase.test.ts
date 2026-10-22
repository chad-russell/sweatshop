import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { diffLines } from "../lib/text-diff";
import { applyPRState, phaseFromMessages, type Phase } from "../lib/thread-phase";

/** 0064 PR3: survivors of lib/plan.ts — the settings diff and the header chip. */

describe("diffLines (LCS)", () => {
  it("diffs lines by LCS", () => {
    const d = diffLines("a\n- [ ] add the column\n- [ ] wire the card", "a\n- [x] add the column\n- [ ] wire the card\n- [ ] tests");
    expect(d.filter((l) => l.op === "del").map((l) => l.text)).toEqual(["- [ ] add the column"]);
    expect(d.filter((l) => l.op === "add").map((l) => l.text)).toEqual(["- [x] add the column", "- [ ] tests"]);
    expect(d.filter((l) => l.op === "same").map((l) => l.text)).toEqual(["a", "- [ ] wire the card"]);
    expect(diffLines("a\nb", "a\nb").every((l) => l.op === "same")).toBe(true);
    expect(diffLines("", "x")).toEqual([
      { op: "del", text: "" },
      { op: "add", text: "x" },
    ]);
  });

  it("degrades to delete-all/add-all past the size guard", () => {
    const big = Array.from({ length: 2_001 }, (_, i) => `l${i}`).join("\n");
    const d = diffLines(big, `${big}\nx`);
    expect(d.filter((l) => l.op === "same")).toHaveLength(0);
    expect(d.filter((l) => l.op === "del")).toHaveLength(2_001);
    expect(d.filter((l) => l.op === "add")).toHaveLength(2_002);
  });
});

describe("applyPRState (0052 live override)", () => {
  const open: Phase = { label: "PR open", tone: "ok", kind: "pr-open", url: "http://x/pull/1" };

  it("relabels a pr-open phase by the host's live answer, keeping the URL", () => {
    expect(applyPRState(open, { state: "merged", mergedAt: "t" })).toEqual({ ...open, label: "PR merged", tone: "ok" });
    expect(applyPRState(open, { state: "closed" })).toEqual({ ...open, label: "PR closed", tone: "warn" });
  });

  it("keeps the derived phase when the answer is unknown or still open", () => {
    expect(applyPRState(open, null)).toBe(open);
    expect(applyPRState(open, { state: "open" })).toBe(open);
  });

  it("never touches another phase, or a missing one", () => {
    const step: Phase = { label: "Build · 1/3", tone: "running" };
    expect(applyPRState(step, { state: "merged" })).toBe(step);
    expect(applyPRState(null, { state: "merged" })).toBeNull();
  });
});

describe("phaseFromMessages", () => {
  const msg = (parts: unknown[]): UIMessage => ({ id: Math.random().toString(36), role: "assistant", parts } as UIMessage);
  const outline = {
    type: "tool-update_outline",
    state: "output-available",
    output: { ok: true, version: 1, proposed: false, outline: { goal: "g", steps: [{ id: "a", label: "Build", state: "active" }, { id: "b", label: "Ship", state: "pending" }] } },
  };

  it("shows the outline chip when there is no PR", () => {
    expect(phaseFromMessages([msg([outline])])?.label).toContain("Build");
  });

  it("a PR wins over the outline, and a failed create_pr clears it", () => {
    const pr = { type: "tool-create_pr", state: "output-available", output: { url: "http://x/pull/2" } };
    expect(phaseFromMessages([msg([outline]), msg([pr])])).toMatchObject({ label: "PR open", kind: "pr-open", url: "http://x/pull/2" });
    const failed = { type: "tool-create_pr", state: "output-error" };
    expect(phaseFromMessages([msg([outline]), msg([pr]), msg([failed])])?.label).toContain("Build");
  });

  it("is null for a chat with neither", () => {
    expect(phaseFromMessages([msg([{ type: "text", text: "hi" }])])).toBeNull();
  });
});
