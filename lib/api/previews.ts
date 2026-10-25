/**
 * 0017/0019: the previews CRUD surface — the list the pill and the
 * palette poll, a card's live read, the log sheet, lifecycle actions
 * (restart/stop/delete, the failure card's retry/dismiss/fix), the
 * New-preview flow's create/confirm, and the project setup editor's
 * PUT. `Candidate` is the New-preview discover step's shape (a
 * provisioned preview's detected run spec).
 */

import type { PreviewSetupDefinition } from "@/lib/previews/setup";
import type { PreviewView } from "@/lib/previews/service";
import { apiFetch, jsonInit } from "./core";

/** A discovered run spec in a create response (`candidates`). */
export interface Candidate {
  dir: string;
  pm: string;
  script: string;
  command: string;
  install: string;
  port: number;
  seed?: string;
}

/**
 * Fetch a previews list by its pre-built query string ("" = every
 * preview; null only means "not fetched"). Null on any failure,
 * network included — the caller keeps its previous list.
 */
export async function listPreviews(query: string): Promise<PreviewView[] | null> {
  try {
    const qs = query ? `?${query}` : "";
    const res = await apiFetch<{ previews: PreviewView[] }>(`/api/previews${qs}`, { cache: "no-store" });
    return res.ok ? (res.body?.previews ?? null) : null;
  } catch {
    return null;
  }
}

/** A single preview's live view (cards poll this). Null on any
 * failure, network included. */
export async function getPreview(id: string): Promise<PreviewView | null> {
  try {
    const res = await apiFetch<{ preview: PreviewView }>(`/api/previews/${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    return res.ok ? (res.body?.preview ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * The log sheet's tail (`logs=300&env=1`). Reads the body whatever the
 * status — the sheet's empty-string defaults were the endpoint's own
 * fallbacks; network errors reject (the sheet's effect leaves the last
 * log up, as it did).
 */
export async function getPreviewLog(
  id: string,
): Promise<{ log: string; env: Record<string, string> | null }> {
  const res = await apiFetch<{ log?: string; env?: Record<string, string> | null }>(
    `/api/previews/${encodeURIComponent(id)}?logs=300&env=1`,
    { cache: "no-store" },
  );
  return { log: res.body?.log ?? "", env: res.body?.env ?? null };
}

/**
 * Restart/stop/delete (the pill's list and cards). Null on success;
 * the endpoint's `{error}` or `action failed (status)` otherwise.
 * Network errors reject, as the action buttons did.
 */
export async function previewAction(
  id: string,
  action: "restart" | "stop" | "delete",
): Promise<string | null> {
  const res = await apiFetch<{ error?: string }>(
    `/api/previews/${encodeURIComponent(id)}`,
    jsonInit("POST", { action }),
  );
  if (res.ok) return null;
  return (res.body as { error?: string } | null)?.error ?? `${action} failed (${res.status})`;
}

/**
 * The failure card's answers (same endpoint, needs-you semantics).
 * Null on success; `${action} failed` (no status — the card's own
 * message) otherwise. Network errors reject.
 */
export async function answerPreviewFailure(id: string, action: "retry" | "dismiss"): Promise<string | null> {
  const res = await apiFetch<{ error?: string }>(
    `/api/previews/${encodeURIComponent(id)}`,
    jsonInit("POST", { action }),
  );
  if (res.ok) return null;
  return (res.body as { error?: string } | null)?.error ?? `${action} failed`;
}

/**
 * Start a fix chat for a failed preview. `{url}` to push to; on any
 * failure the endpoint's `error` or the card's fallback. Network
 * errors reject.
 */
export async function fixPreview(id: string): Promise<{ url: string } | { error: string }> {
  const res = await apiFetch<{ url?: string; error?: string }>(
    `/api/previews/${encodeURIComponent(id)}/fix`,
    { method: "POST" },
  );
  if (res.ok && res.body?.url) return { url: res.body.url };
  return { error: res.body?.error ?? "could not start a fix chat" };
}

/**
 * POST /api/previews — the New-preview create. `{candidates}` (with
 * the pending preview's id) switches the flow to discover; otherwise
 * `{preview.id}` finishes it. Network errors reject.
 */
export async function createPreview(
  body: Record<string, unknown>,
): Promise<
  | { ok: true; preview?: { id: string }; candidates?: Candidate[] }
  | { ok: false; error: string }
> {
  const res = await apiFetch<{ error?: string; preview?: { id: string }; candidates?: Candidate[] }>(
    "/api/previews",
    jsonInit("POST", body),
  );
  if (res.ok) return { ok: true, preview: res.body?.preview, candidates: res.body?.candidates };
  return { ok: false, error: res.body?.error ?? `could not create (${res.status})` };
}

/**
 * POST /api/previews/<id> `{action: "confirm", …}` — adopt the
 * discovered candidate. Null on success (also for an ok-with-error
 * body, which the flow treats as a failure); `could not launch
 * (status)` otherwise. Network errors reject.
 */
export async function confirmPreview(previewId: string, body: Record<string, unknown>): Promise<string | null> {
  const res = await apiFetch<{ error?: string }>(
    `/api/previews/${encodeURIComponent(previewId)}`,
    jsonInit("POST", { action: "confirm", ...body }),
  );
  if (res.ok && !res.body?.error) return null;
  return res.body?.error ?? `could not launch (${res.status})`;
}

/**
 * The project's saved preview setup (the New-preview flow reads it to
 * decide label-only vs full definition). Null when there is none or
 * any failure — the flow provisions fresh. Never throws.
 */
export async function getPreviewSetup(projectId: string): Promise<PreviewSetupDefinition | null> {
  try {
    const res = await apiFetch<{ setup?: { definition: PreviewSetupDefinition } | null }>(
      `/api/previews/setup?projectId=${encodeURIComponent(projectId)}`,
      { cache: "no-store" },
    );
    return res.body?.setup?.definition ?? null;
  } catch {
    return null;
  }
}

/**
 * PUT /api/previews/setup — save the project's setup definition. Null
 * on success; `could not save (status)` otherwise. Network errors
 * reject (the editor's busy flag resets in its finally either way).
 */
export async function savePreviewSetup(
  projectId: string,
  definition: PreviewSetupDefinition,
): Promise<string | null> {
  const res = await apiFetch<{ error?: string }>(
    "/api/previews/setup",
    jsonInit("PUT", { projectId, definition }),
  );
  if (res.ok) return null;
  return (res.body as { error?: string } | null)?.error ?? `could not save (${res.status})`;
}
