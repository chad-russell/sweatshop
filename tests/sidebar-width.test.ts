import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  parseSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "../lib/sidebar-width";

describe("clampSidebarWidth", () => {
  it("passes values already in range through unchanged", () => {
    expect(clampSidebarWidth(SIDEBAR_WIDTH_DEFAULT)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(clampSidebarWidth(300)).toBe(300);
  });

  it("clamps below the minimum and above the maximum", () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(SIDEBAR_WIDTH_MIN - 1)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(SIDEBAR_WIDTH_MAX + 1)).toBe(SIDEBAR_WIDTH_MAX);
    expect(clampSidebarWidth(10_000)).toBe(SIDEBAR_WIDTH_MAX);
  });
});

describe("parseSidebarWidth", () => {
  it("returns null for null, missing, or non-numeric input", () => {
    expect(parseSidebarWidth(null)).toBeNull();
    expect(parseSidebarWidth("")).toBeNull();
    expect(parseSidebarWidth("not-a-number")).toBeNull();
  });

  it("parses and clamps numeric strings", () => {
    expect(parseSidebarWidth("300")).toBe(300);
    expect(parseSidebarWidth("0")).toBe(SIDEBAR_WIDTH_MIN);
    expect(parseSidebarWidth("9999")).toBe(SIDEBAR_WIDTH_MAX);
  });
});
