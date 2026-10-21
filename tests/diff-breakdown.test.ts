import { describe, expect, it } from "vitest";
import { classifyDiff, isDiffBreakdown, parseNumstatZ } from "../lib/diff-breakdown";

/**
 * 0059: the diff-breakdown chip's pure core — fixture numstats, no git
 * needed. Covers the `-z` rename form (empty path field, two NUL-separated
 * paths), binary rows (`-\t-`), and the fixed first-match-wins categories.
 */

describe("parseNumstatZ", () => {
  it("parses plain rows", () => {
    const rows = parseNumstatZ("3\t1\tlib/foo.ts\0" + "12\t0\tdocs/bar.md\0");
    expect(rows).toEqual([
      { path: "lib/foo.ts", added: 3, deleted: 1, binary: false },
      { path: "docs/bar.md", added: 12, deleted: 0, binary: false },
    ]);
  });

  it("uses the new path on the -z rename form (empty path field, two NUL paths)", () => {
    const rows = parseNumstatZ("2\t2\t\0old/path.ts\0new/path.ts\0");
    expect(rows).toEqual([{ path: "new/path.ts", added: 2, deleted: 2, binary: false }]);
  });

  it("treats '-\\t-' as a binary row with zero counts", () => {
    const rows = parseNumstatZ("-\t-\tassets/logo.png\0");
    expect(rows).toEqual([{ path: "assets/logo.png", added: 0, deleted: 0, binary: true }]);
  });

  it("handles a binary rename and a mix of row kinds together", () => {
    const rows = parseNumstatZ(
      "5\t0\tlib/a.ts\0" + "-\t-\t\0old.png\0new.png\0" + "0\t3\tREADME.md\0",
    );
    expect(rows).toEqual([
      { path: "lib/a.ts", added: 5, deleted: 0, binary: false },
      { path: "new.png", added: 0, deleted: 0, binary: true },
      { path: "README.md", added: 0, deleted: 3, binary: false },
    ]);
  });

  it("returns no rows for empty output", () => {
    expect(parseNumstatZ("")).toEqual([]);
  });
});

describe("classifyDiff", () => {
  it("leaves zero-row categories out, in fixed display order", () => {
    const breakdown = classifyDiff([
      { path: "lib/thing.ts", added: 10, deleted: 2, binary: false },
      { path: "docs/0059-x.md", added: 5, deleted: 0, binary: false },
    ]);
    expect(breakdown.categories.map((c) => c.key)).toEqual(["docs", "code"]);
    expect(breakdown.files).toBe(2);
    expect(breakdown.added).toBe(15);
    expect(breakdown.deleted).toBe(2);
  });

  it("sorts lockfiles and drizzle meta snapshots as Generated", () => {
    const breakdown = classifyDiff([
      { path: "package-lock.json", added: 100, deleted: 50, binary: false },
      { path: "pnpm-lock.yaml", added: 1, deleted: 1, binary: false },
      { path: "foo.lock", added: 1, deleted: 1, binary: false },
      { path: "drizzle/meta/0012_snapshot.json", added: 20, deleted: 0, binary: false },
      { path: ".agents/claude/settings.json", added: 2, deleted: 0, binary: false },
      { path: "components/__snapshots__/x.snap", added: 3, deleted: 0, binary: false },
      { path: "skills-lock.json", added: 1, deleted: 0, binary: false },
    ]);
    expect(breakdown.categories).toHaveLength(1);
    expect(breakdown.categories[0]).toMatchObject({ key: "generated", files: 7 });
  });

  it("counts mocks and fixtures as Tests, not Code (decided)", () => {
    const breakdown = classifyDiff([
      { path: "tests/foo.test.ts", added: 1, deleted: 0, binary: false },
      { path: "lib/agent/tools/__tests__/thing.ts", added: 1, deleted: 0, binary: false },
      { path: "lib/fixtures/sample.json", added: 1, deleted: 0, binary: false },
      { path: "lib/agent/tools/mock-provider.ts", added: 1, deleted: 0, binary: false },
      { path: "lib/agent/tools/search-mock.util.ts", added: 1, deleted: 0, binary: false },
      { path: "components/thing.spec.tsx", added: 1, deleted: 0, binary: false },
    ]);
    expect(breakdown.categories).toHaveLength(1);
    expect(breakdown.categories[0]).toMatchObject({ key: "tests", files: 6 });
  });

  it("sorts docs, migrations and config independently of Code", () => {
    const breakdown = classifyDiff([
      { path: "docs/0059-diff-breakdown.md", added: 40, deleted: 0, binary: false },
      { path: "README.mdx", added: 1, deleted: 0, binary: false },
      { path: "drizzle/0013_add_column.sql", added: 8, deleted: 0, binary: false },
      { path: "next.config.ts", added: 2, deleted: 1, binary: false },
      { path: "package.json", added: 1, deleted: 1, binary: false },
      { path: "tsconfig.json", added: 1, deleted: 0, binary: false },
      { path: ".github/workflows/ci.yml", added: 3, deleted: 0, binary: false },
      { path: "Containerfile.sandbox", added: 1, deleted: 0, binary: false },
      { path: "lib/diff-breakdown.ts", added: 100, deleted: 0, binary: false },
    ]);
    expect(breakdown.categories.map((c) => c.key)).toEqual(["docs", "migrations", "config", "code"]);
    const config = breakdown.categories.find((c) => c.key === "config");
    expect(config).toMatchObject({ files: 5 });
  });

  it("first match wins: drizzle/meta/** (Generated) beats drizzle/*.sql (Migrations)", () => {
    const breakdown = classifyDiff([
      { path: "drizzle/meta/_journal.json", added: 1, deleted: 0, binary: false },
      { path: "drizzle/0001_init.sql", added: 1, deleted: 0, binary: false },
    ]);
    expect(breakdown.categories).toEqual([
      { key: "generated", label: "Generated", files: 1, added: 1, deleted: 0 },
      { key: "migrations", label: "Migrations", files: 1, added: 1, deleted: 0 },
    ]);
  });

  it("binary files count toward files but add no lines", () => {
    const breakdown = classifyDiff([{ path: "assets/shot.png", added: 0, deleted: 0, binary: true }]);
    expect(breakdown).toEqual({
      files: 1,
      added: 0,
      deleted: 0,
      categories: [{ key: "code", label: "Code", files: 1, added: 0, deleted: 0 }],
    });
  });

  it("returns no categories for no rows", () => {
    expect(classifyDiff([])).toEqual({ files: 0, added: 0, deleted: 0, categories: [] });
  });
});

describe("isDiffBreakdown", () => {
  it("accepts a well-shaped breakdown and rejects everything else", () => {
    const breakdown = classifyDiff([{ path: "a.ts", added: 1, deleted: 0, binary: false }]);
    expect(isDiffBreakdown(breakdown)).toBe(true);
    expect(isDiffBreakdown(undefined)).toBe(false);
    expect(isDiffBreakdown(null)).toBe(false);
    expect(isDiffBreakdown({ url: "https://example.com", number: 3 })).toBe(false);
  });
});
