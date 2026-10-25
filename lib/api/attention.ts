/**
 * The sidebar's attention signature (one poll while visible): null on
 * any failure means "no opinion" — the sync only refreshes when it
 * actually reads a signature that differs from the rendered one.
 */

import { apiFetch } from "./core";

/** The attention signature, or null when the read failed or the body
 * had none. Never throws. */
export async function getAttentionSignature(): Promise<string | null> {
  try {
    const res = await apiFetch<{ signature?: string }>("/api/attention", { cache: "no-store" });
    if (!res.ok) return null;
    return typeof res.body?.signature === "string" ? res.body.signature : null;
  } catch {
    return null;
  }
}
