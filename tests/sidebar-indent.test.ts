import { describe, expect, it } from "vitest";
import { GAP, INDENT, ROW_PAD, SLOT, guideLeft, labelInset, rowInset } from "@/components/sidebar/indent";

describe("sidebar indent", () => {
  it("steps one INDENT per depth from the row padding", () => {
    expect(rowInset(0)).toBe(ROW_PAD);
    expect(rowInset(3) - rowInset(2)).toBe(INDENT);
  });

  it("puts the label after the handle and chevron slots", () => {
    expect(labelInset(0)).toBe(ROW_PAD + 2 * (SLOT + GAP));
    expect(labelInset(2) - labelInset(1)).toBe(INDENT);
  });

  it("aligns a child's chevron under its parent's icon column", () => {
    const parentIcon = labelInset(0);
    const childChevron = rowInset(1) + SLOT + GAP;
    expect(childChevron).toBe(parentIcon - SLOT - GAP + INDENT);
  });

  it("draws the guide line inside the parent's chevron slot", () => {
    expect(guideLeft(1)).toBeGreaterThan(rowInset(1) + SLOT + GAP);
    expect(guideLeft(1)).toBeLessThan(labelInset(1));
  });
});
