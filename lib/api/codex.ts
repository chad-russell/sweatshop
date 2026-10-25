/**
 * 0050: the codex subscription login flows — browser (primary) and
 * device (disclosure), logout, and the auth-paste escape hatch. Each
 * function maps the endpoint's `{error}`/status to the row's own
 * messages; network errors always reject so the row's catch can say
 * "could not reach the server".
 */

import type { CodexBrowserHandle, CodexLoginHandle } from "@/lib/harness-auth/codex-login";
import { apiFetch, jsonInit } from "./core";

/** POST /api/x/codex/login `{action: "browser_start"}` — the authorize
 * URL to open plus the browser-flow handle the callback completes. */
export async function codexBrowserStart(): Promise<
  { authorizeUrl: string; handle: CodexBrowserHandle } | { error: string }
> {
  const res = await apiFetch<{ error?: string; authorizeUrl?: string; handle?: CodexBrowserHandle }>(
    "/api/x/codex/login",
    jsonInit("POST", { action: "browser_start" }),
  );
  if (res.ok && res.body?.authorizeUrl && res.body.handle) {
    return { authorizeUrl: res.body.authorizeUrl, handle: res.body.handle };
  }
  return { error: res.body?.error ?? `login failed (${res.status})` };
}

/** POST /api/x/codex/login `{action: "browser_complete"}` — hand over
 * the pasted callback URL. Null on success, the failure message
 * otherwise. */
export async function codexBrowserComplete(handle: CodexBrowserHandle, callbackUrl: string): Promise<string | null> {
  const res = await apiFetch<{ error?: string }>(
    "/api/x/codex/login",
    jsonInit("POST", { action: "browser_complete", handle, callbackUrl }),
  );
  return res.ok ? null : (res.body?.error ?? `login failed (${res.status})`);
}

/** POST /api/x/codex/login/poll — one device-flow poll tick. */
export async function codexLoginPoll(
  handle: CodexLoginHandle,
): Promise<{ status: "pending"; handle: CodexLoginHandle } | { status: "approved" } | { error: string }> {
  const res = await apiFetch<{ error?: string; status?: string; handle?: CodexLoginHandle }>(
    "/api/x/codex/login/poll",
    jsonInit("POST", { handle }),
  );
  if (res.ok && res.body?.status === "pending" && res.body.handle) {
    return { status: "pending", handle: res.body.handle };
  }
  if (res.ok && res.body?.status === "approved") return { status: "approved" };
  return { error: res.body?.error ?? `login failed (${res.status})` };
}

/** POST /api/x/codex/login/start — the device flow's code + URL plus
 * the handle its polls continue with. */
export async function codexDeviceStart(): Promise<
  { userCode: string; verificationUrl: string; handle: CodexLoginHandle } | { error: string }
> {
  const res = await apiFetch<{
    error?: string;
    userCode?: string;
    verificationUrl?: string;
    handle?: CodexLoginHandle;
  }>("/api/x/codex/login/start", { method: "POST" });
  if (res.ok && res.body?.userCode && res.body.verificationUrl && res.body.handle) {
    return {
      userCode: res.body.userCode,
      verificationUrl: res.body.verificationUrl,
      handle: res.body.handle,
    };
  }
  return { error: res.body?.error ?? `login failed (${res.status})` };
}

/** DELETE /api/x/codex/login — forget the saved login. Null on
 * success, `logout failed …` otherwise. */
export async function codexLogout(): Promise<string | null> {
  const res = await apiFetch<{ error?: string }>("/api/x/codex/login", { method: "DELETE" });
  return res.ok ? null : (res.body?.error ?? `logout failed (${res.status})`);
}

/** POST /api/x/codex/login `{action: "paste"}` — install a pasted
 * auth.json directly. Null on success, `save failed …` otherwise. */
export async function codexPasteAuth(authJson: string): Promise<string | null> {
  const res = await apiFetch<{ error?: string }>("/api/x/codex/login", jsonInit("POST", { action: "paste", authJson }));
  return res.ok ? null : (res.body?.error ?? `save failed (${res.status})`);
}
