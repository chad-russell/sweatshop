/**
 * 0063: the harness session view — one generic window over
 * GET /api/harness/<session> (the card's activity tail, the page's
 * older page, the running poll's after-tail) — and 0066's cooperative
 * call cancel. `E` is the event type each caller already trusts
 * (TimelineEvent for the card, HarnessEvent for the page).
 */

import type { HarnessRun } from "@/components/harness-session-view";
import { apiFetch } from "./core";

/** One harness events window. `run` only the poll reads (the card and
 * the older page ignore it); `hasOlder` pages backward. */
export interface HarnessWindow<E> {
  run: HarnessRun | null;
  events: E[];
  hasOlder: boolean;
}

/**
 * Fetch an events window: `tail` bounds it, `before` pages older,
 * `after` polls for newer, `from`/`to` scope a single call's page.
 * Null on any failure, network included — every caller keeps what it
 * has and waits for the next tick.
 */
export async function fetchHarnessWindow<E>(
  sessionId: string,
  params: { harness: string; tail?: number; before?: number; after?: number; from?: number; to?: number },
): Promise<HarnessWindow<E> | null> {
  const qs = new URLSearchParams({ harness: params.harness });
  if (params.tail !== undefined) qs.set("tail", String(params.tail));
  if (params.before !== undefined) qs.set("before", String(params.before));
  if (params.after !== undefined) qs.set("after", String(params.after));
  if (params.from !== undefined) qs.set("from", String(params.from));
  if (params.to !== undefined) qs.set("to", String(params.to));
  try {
    const res = await apiFetch<Partial<HarnessWindow<E>>>(`/api/harness/${encodeURIComponent(sessionId)}?${qs}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return {
      run: res.body?.run ?? null,
      events: res.body?.events ?? [],
      hasOlder: res.body?.hasOlder === true,
    };
  } catch {
    return null;
  }
}

/**
 * 0066: cooperative cancel — settles the call now; the workflow tears
 * the bridge down at its next step boundary. Never throws: a network
 * failure is the same "failed to cancel" the catch arm showed.
 */
export async function cancelHarnessCall(callId: string): Promise<{ ok: boolean; error: string | null }> {
  try {
    const res = await apiFetch<{ ok?: boolean; message?: string }>(
      `/api/x/harness-calls/${encodeURIComponent(callId)}/cancel`,
      { method: "POST" },
    );
    if (res.ok && res.body?.ok === true) return { ok: true, error: null };
    return { ok: false, error: res.body?.message ?? "failed to cancel" };
  } catch {
    return { ok: false, error: "failed to cancel" };
  }
}
