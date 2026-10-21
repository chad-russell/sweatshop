import { afterEach, describe, expect, it } from "vitest";
import { ownerName, possessive, renderOwnerPlaceholders } from "../lib/agent/owner";

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

describe("renderOwnerPlaceholders", () => {
  const saved = process.env.SWEATSHOP_OWNER_NAME;
  afterEach(() => {
    if (saved === undefined) delete process.env.SWEATSHOP_OWNER_NAME;
    else process.env.SWEATSHOP_OWNER_NAME = saved;
  });

  it("replaces {{owner}} and {{owner's}} with the current owner, read fresh", () => {
    process.env.SWEATSHOP_OWNER_NAME = "Riley";
    expect(renderOwnerPlaceholders("Ask {{owner}} — it's {{owner's}} call.")).toBe(
      "Ask Riley — it's Riley's call.",
    );
  });

  it("possessive of a name ending in s drops the trailing s, same as possessive()", () => {
    process.env.SWEATSHOP_OWNER_NAME = "James";
    expect(renderOwnerPlaceholders("{{owner's}} tracker")).toBe("James' tracker");
  });

  it("defaults to Chad with no env override", () => {
    delete process.env.SWEATSHOP_OWNER_NAME;
    expect(renderOwnerPlaceholders("{{owner}} / {{owner's}}")).toBe("Chad / Chad's");
  });

  it("leaves text with no placeholders untouched", () => {
    expect(renderOwnerPlaceholders("no placeholders here")).toBe("no placeholders here");
  });
});
