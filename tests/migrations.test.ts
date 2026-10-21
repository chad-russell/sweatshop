import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 0059 bugfix: drizzle's migrator runs migrations in journal order, but
 * nothing enforced that each entry's `when` timestamp is actually later
 * than the one before it — 0058's `when` was generated SMALLER than
 * 0057's, which would have applied (or skipped) it out of order on a
 * database that already had 0057. This would have caught that.
 */
describe("drizzle/meta/_journal.json: migration order", () => {
  it("every entry's `when` strictly increases with its index", () => {
    const journal = JSON.parse(
      readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; when: number; tag: string }[] };
    const entries = journal.entries;
    expect(entries.length).toBeGreaterThan(0);
    for (let i = 1; i < entries.length; i += 1) {
      const prev = entries[i - 1]!;
      const curr = entries[i]!;
      expect(curr.when, `${curr.tag} (when=${curr.when}) must be after ${prev.tag} (when=${prev.when})`).toBeGreaterThan(prev.when);
    }
  });

  it("every entry's idx matches its array position", () => {
    const journal = JSON.parse(
      readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number }[] };
    journal.entries.forEach((entry, i) => expect(entry.idx).toBe(i));
  });
});
