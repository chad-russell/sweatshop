import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The default sandbox image ref: the `localhost/sweatshop-sandbox`
 * fallback, with SWEATSHOP_SANDBOX_IMAGE overriding it (a differently
 * tagged build, or a pullable ref on an engine without a local one —
 * docs/agent/sandboxes.md).
 */

const ORIGINAL = process.env.SWEATSHOP_SANDBOX_IMAGE;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SWEATSHOP_SANDBOX_IMAGE;
  else process.env.SWEATSHOP_SANDBOX_IMAGE = ORIGINAL;
  vi.resetModules();
});

async function loadImage(): Promise<string> {
  const { DEFAULT_SANDBOX_IMAGE } = await import("../lib/sandboxes/provision");
  return DEFAULT_SANDBOX_IMAGE;
}

describe("default sandbox image", () => {
  it("falls back to the localhost build when the env is unset", async () => {
    delete process.env.SWEATSHOP_SANDBOX_IMAGE;
    expect(await loadImage()).toBe("localhost/sweatshop-sandbox");
  });

  it("SWEATSHOP_SANDBOX_IMAGE overrides the ref", async () => {
    process.env.SWEATSHOP_SANDBOX_IMAGE = "docker.io/me/sweatshop-sandbox:v1";
    expect(await loadImage()).toBe("docker.io/me/sweatshop-sandbox:v1");
  });
});
