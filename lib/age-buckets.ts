/**
 * 0007: deterministic age buckets for a group's own conversations — local calendar days,
 * not rolling 24h windows, so "Today" means since local midnight.
 */
export type AgeBucket = "Today" | "Yesterday" | "This week" | "Older";

export const AGE_BUCKETS: readonly AgeBucket[] = [
  "Today",
  "Yesterday",
  "This week",
  "Older",
];

export function localDayStart(ms: number, daysAgo = 0): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  // Local calendar arithmetic, not 24h subtraction (DST days vary in length).
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

/** Bucket for a timestamp relative to `now` (both Unix ms). */
export function ageBucket(ms: number, now: number = Date.now()): AgeBucket {
  const today = localDayStart(now);
  if (ms >= today) return "Today";
  // setDate arithmetic stays correct across DST changes (24h ≠ a day).
  if (ms >= localDayStart(now, 1)) return "Yesterday";
  if (ms >= localDayStart(now, 6)) return "This week";
  return "Older";
}

/** Group items (any order) into non-empty buckets, newest first. */
export function bucketByAge<T extends { updatedAt: number }>(
  items: readonly T[],
  now: number = Date.now(),
): { bucket: AgeBucket; items: T[] }[] {
  const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
  const out: { bucket: AgeBucket; items: T[] }[] = [];
  for (const bucket of AGE_BUCKETS) {
    const inBucket = sorted.filter((i) => ageBucket(i.updatedAt, now) === bucket);
    if (inBucket.length > 0) out.push({ bucket, items: inBucket });
  }
  return out;
}
