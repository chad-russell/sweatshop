import { describe, expect, it } from "vitest";
import { ownerName, possessive } from "../lib/agent/owner";

/** SWEATSHOP_OWNER_NAME: who the single owner is, interpolated into agent-facing strings. */
describe("owner name", () => {
  it("defaults to Chad and reads env fresh (trimmed; blank falls back)", () => {
    const saved = process.env.SWEATSHOP_OWNER_NAME;
    try {
      delete process.env.SWEATSHOP_OWNER_NAME;
      expect(ownerName()).toBe("Chad");
      process.env.SWEATSHOP_OWNER_NAME = "  Riley  ";
      expect(ownerName()).toBe("Riley");
      process.env.SWEATSHOP_OWNER_NAME = "   ";
      expect(ownerName()).toBe("Chad");
    } finally {
      if (saved === undefined) delete process.env.SWEATSHOP_OWNER_NAME;
      else process.env.SWEATSHOP_OWNER_NAME = saved;
    }
  });

  it("possessive adds 's — or just an apostrophe after an s", () => {
    expect(possessive("Chad")).toBe("Chad's");
    expect(possessive("James")).toBe("James'");
  });
});
