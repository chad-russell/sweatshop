import { describe, expect, it } from "vitest";
import { ageBucket, bucketByAge } from "../lib/age-buckets";

// Local-time construction: buckets are local calendar days.
const at = (y: number, m: number, d: number, h = 12) =>
  new Date(y, m - 1, d, h).getTime();
const now = at(2026, 10, 8, 15);

describe("ageBucket", () => {
  it("uses local calendar days, not rolling 24h", () => {
    expect(ageBucket(at(2026, 10, 8, 0), now)).toBe("Today");
    expect(ageBucket(at(2026, 10, 7, 23), now)).toBe("Yesterday");
    expect(ageBucket(at(2026, 10, 7, 0), now)).toBe("Yesterday");
    expect(ageBucket(at(2026, 10, 6, 23), now)).toBe("This week");
    expect(ageBucket(at(2026, 10, 2, 12), now)).toBe("This week");
    expect(ageBucket(at(2026, 10, 1, 12), now)).toBe("Older");
  });
});

describe("bucketByAge", () => {
  it("returns only non-empty buckets in fixed order, newest first inside", () => {
    const items = [
      { id: "old", updatedAt: at(2026, 9, 1) },
      { id: "today-a", updatedAt: at(2026, 10, 8, 9) },
      { id: "today-b", updatedAt: at(2026, 10, 8, 14) },
    ];
    const out = bucketByAge(items, now);
    expect(out.map((b) => b.bucket)).toEqual(["Today", "Older"]);
    expect(out[0].items.map((i) => i.id)).toEqual(["today-b", "today-a"]);
  });
});
