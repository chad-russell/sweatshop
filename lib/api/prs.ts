/**
 * 0078: live states for the work pill's tracked PR urls. Null on any
 * failure, network included — the pill keeps the last-known states and
 * the next visible tick retries.
 */

import type { PRStateInfo } from "@/lib/use-pr-states";
import { apiFetch } from "./core";

/** The live state per tracked PR url (the endpoint's map, merged over
 * whatever the pill already holds). Never throws. */
export async function getPRStates(urls: readonly string[]): Promise<Record<string, PRStateInfo | null> | null> {
  try {
    const query = urls.map((url) => `url=${encodeURIComponent(url)}`).join("&");
    const res = await apiFetch<Record<string, PRStateInfo | null>>(`/api/x/prs?${query}`, { cache: "no-store" });
    return res.ok ? res.body : null;
  } catch {
    return null;
  }
}
