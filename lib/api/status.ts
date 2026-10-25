/**
 * 0040: a child's live status card read (both live kinds — harness
 * call and child thread). Null on any failure, network included — the
 * poller keeps the last status and the next visible tick retries.
 */

import type { ChildStatus } from "@/lib/child-status";
import { apiFetch } from "./core";

/** The child's live status. Never throws. */
export async function getChildStatus(id: string): Promise<ChildStatus | null> {
  try {
    const res = await apiFetch<ChildStatus>(`/api/x/status/${encodeURIComponent(id)}`, { cache: "no-store" });
    return res.ok ? res.body : null;
  } catch {
    return null;
  }
}
