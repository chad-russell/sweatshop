import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { diffLines } from "../lib/text-diff";
import { phaseFromMessages } from "../lib/thread-phase";

/** 0064 PR3: survivors of lib/plan.ts — the settings diff and the header
 *  chip. 0078: the chip is outline-only now — a PR lives in the work
 *  pill (tests/work-prs.test.ts), not here. */

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

describe("phaseFromMessages", () => {
  const msg = (parts: unknown[]): UIMessage => ({ id: Math.random().toString(36), role: "assistant", parts } as UIMessage);
  const outline = {
    type: "tool-update_outline",
    state: "output-available",
    output: { ok: true, version: 1, proposed: false, outline: { goal: "g", steps: [{ id: "a", label: "Build", state: "active" }, { id: "b", label: "Ship", state: "pending" }] } },
  };

  it("shows the outline chip", () => {
    expect(phaseFromMessages([msg([outline])])?.label).toContain("Build");
  });

  it("a create_pr call never becomes the phase (0078: it lives in the work pill)", () => {
    const pr = { type: "tool-create_pr", state: "output-available", output: { url: "http://x/pull/2" } };
    expect(phaseFromMessages([msg([outline]), msg([pr])])?.label).toContain("Build");
  });

  it("is null for a chat with no outline", () => {
    expect(phaseFromMessages([msg([{ type: "text", text: "hi" }])])).toBeNull();
  });
});
