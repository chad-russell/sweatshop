/**
 * 0013: sandbox lifecycle from the client — the composer's picker
 * options, the detail row's stop/destroy, and the reaper's run-now
 * button. `SandboxOption` is the picker's row (chat-session used to
 * own the type; the API module that fills it does now).
 */

import { apiFetch, jsonInit } from "./core";

/** A running sandbox the composer can attach to. */
export interface SandboxOption {
  id: string;
  status: string;
  ownerKind: string;
  ownerId: string;
  /** Chat title or machine run name. */
  ownerLabel: string;
  projectId: string | null;
  projectName: string | null;
  lastUsedAt: number;
  chats: number;
  ref: string;
}

/**
 * The picker's options. Null on any failure, network included — the
 * dropdown just shows fewer options.
 */
export async function listSandboxChoices(): Promise<SandboxOption[] | null> {
  try {
    const res = await apiFetch<{ sandboxes?: SandboxOption[] }>("/api/x/sandboxes");
    return res.ok ? (res.body?.sandboxes ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Stop or destroy a sandbox. Null on success; the endpoint's `{error}`
 * or `failed (status)` otherwise. Network errors reject (the row's
 * try/finally resets its busy flag).
 */
export async function sandboxAction(sandboxId: string, action: "stop" | "destroy"): Promise<string | null> {
  const res = await apiFetch<{ error?: string }>(
    `/api/sandboxes/${encodeURIComponent(sandboxId)}`,
    jsonInit("POST", { action }),
  );
  if (res.ok) return null;
  return (res.body as { error?: string } | null)?.error ?? `failed (${res.status})`;
}

/** One reaper decision from a run-now report. */
export interface ReapAction {
  sandboxId: string;
  action: "stop" | "destroy" | "drop-stale" | "skip-busy";
}

/** POST /api/sandboxes/reap — run the same pass the in-app timer runs.
 * `{report}` on success, `{status}` for the `cleanup failed (n)` note.
 * Network errors reject — the button's catch shows plain "cleanup
 * failed". */
export async function reapSandboxes(): Promise<
  { ok: true; report: { actions: ReapAction[]; errors: unknown[] } } | { ok: false; status: number }
> {
  const res = await apiFetch<{ actions?: ReapAction[]; errors?: unknown[] }>("/api/sandboxes/reap", {
    method: "POST",
  });
  if (res.ok) return { ok: true, report: { actions: res.body?.actions ?? [], errors: res.body?.errors ?? [] } };
  return { ok: false, status: res.status };
}
