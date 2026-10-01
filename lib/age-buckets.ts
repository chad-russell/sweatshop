/**
 * 0007: deterministic age buckets for the Inbox — local calendar days,
 * not rolling 24h windows, so "Today" means since local midnight.
 */
export type AgeBucket = "Today" | "Yesterday" | "This week" | "Older";

export const AGE_BUCKETS: readonly AgeBucket[] = [
  "Today",
  "Yesterday",
  "This week",
  "Older",
];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Bucket for a timestamp relative to `now` (both Unix ms). */
export function ageBucket(ms: number, now: number = Date.now()): AgeBucket {
  const today = startOfDay(now);
  if (ms >= today) return "Today";
  // setDate arithmetic stays correct across DST changes (24h ≠ a day).
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (ms >= yesterday.getTime()) return "Yesterday";
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 6);
  if (ms >= weekAgo.getTime()) return "This week";
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
