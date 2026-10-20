import { describe, expect, it, vi } from "vitest";

/**
 * 0054 hardening (5): action=preview must never render a blank section
 * when seeding actually fails — it must surface the failure as an
 * error, not silently default to "". A real seed failure (disk full,
 * a corrupt row) is hard to provoke honestly in a test db, so this
 * mocks `getTarget` to simulate exactly that for one section and
 * asserts the route reports it instead of hiding it. Isolated in its
 * own file: `vi.mock` replaces the whole module for every test in this
 * file, which would be wrong to do anywhere tests exercise real seeding.
 */

vi.mock("../db/prompt-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/prompt-settings")>();
  return {
    ...actual,
    getTarget: (db: unknown, target: unknown) => {
      const t = target as { kind: string; key?: string };
      if (t.kind === "section" && t.key === "harness_steering") return null;
      return actual.getTarget(db as never, target);
    },
  };
});

describe("GET /api/settings/agent?action=preview: a seed failure is never silent", () => {
  it("500s with a clear message instead of assembling a prompt with a blank section", async () => {
    const { GET } = await import("../app/api/settings/agent/route");
    const res = await GET(new Request("http://x/api/settings/agent?action=preview"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("harness_steering");
    expect(body.error).toMatch(/seed/i);
  });
});
