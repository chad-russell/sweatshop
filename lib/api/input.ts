/**
 * 0010 human input over POST /api/x/input — the three payload shapes
 * the UI sends (an approval `{approved}`, a freeform `{answer}`, a 0081
 * structured card's `{answers}`) plus the 0064 outline flows
 * (`editOutline`/`approveOutline`). The transcript cards' own poll and
 * optimistic answer (lib/use-pending-input.ts) are deliberately NOT
 * migrated — their stop-on-recognized semantics stay local to the hook.
 */

import type { Outline } from "@/lib/outline";
import type { QuestionAnswer } from "@/lib/question-form";
import { apiFetch, apiError, jsonInit, type ApiResult } from "./core";

/** The resolvable payloads POST /api/x/input accepts (sans the outline
 * flows below). */
export type RespondBody =
  | { toolCallId: string; approved: boolean; comment?: string }
  | { toolCallId: string; answer: string }
  | { toolCallId: string; answers: Record<string, QuestionAnswer> };

/**
 * Answer a pending request. Never throws: a network failure is
 * `"Network error — is the server up?"`, an HTTP failure the endpoint's
 * `{error}` or `Request failed (status)` — the inbox's respond hook
 * surfaces whichever it gets.
 */
export async function respondToInput(body: RespondBody): Promise<{ ok: true } | { ok: false; error: string }> {
  let res: ApiResult;
  try {
    res = await apiFetch("/api/x/input", jsonInit("POST", body));
  } catch {
    return { ok: false, error: "Network error — is the server up?" };
  }
  if (!res.ok) return { ok: false, error: apiError(res, "Request failed") };
  return { ok: true };
}

/** The saved shape of a successful outline edit (stale-check metadata
 * for the next edit). */
export interface EditOutlineResponse {
  version: number;
  rowId: string;
  approved: boolean;
}

/** 0064: save an owner outline edit (optionally approving in the same
 * request). Never throws — `{failure, saved}` carries the error either
 * way, exactly as the outline editor's own helper did. */
export async function editOutline(input: {
  conversationId: string;
  outline: Outline;
  baseVersion: number;
  approve?: boolean;
  note?: string;
}): Promise<{ failure: string | null; saved: EditOutlineResponse | null }> {
  try {
    const res = await apiFetch<{ error?: string } & Partial<EditOutlineResponse>>(
      "/api/x/input",
      jsonInit("POST", {
        conversationId: input.conversationId,
        editOutline: input.outline,
        baseVersion: input.baseVersion,
        ...(input.approve ? { approve: true } : {}),
        ...(input.note ? { note: input.note } : {}),
      }),
    );
    if (res.ok) return { failure: null, saved: (res.body as EditOutlineResponse | null) ?? null };
    return { failure: res.body?.error ?? `save failed (${res.status})`, saved: null };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error), saved: null };
  }
}

/** 0064: approve an open outline review (with an optional note). Null
 * on success, the failure message otherwise; never throws. */
export async function approveOutline(toolCallId: string, note?: string): Promise<string | null> {
  try {
    const res = await apiFetch<{ error?: string }>(
      "/api/x/input",
      jsonInit("POST", { toolCallId, approveOutline: true, ...(note ? { note } : {}) }),
    );
    if (res.ok) return null;
    return res.body?.error ?? `approve failed (${res.status})`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
