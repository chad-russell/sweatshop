import { NextResponse } from "next/server";
import {
  completeCodexBrowserLogin,
  startCodexBrowserLogin,
  type CodexBrowserHandle,
} from "@/lib/harness-auth/codex-login";
import { clearCodexCredential, saveCodexCredential } from "@/lib/harness-auth/codex";

export const dynamic = "force-dynamic";

/**
 * 0050 phases 5/5b: the codex login's account-level verbs.
 * {action:"browser_start"} / {action:"browser_complete", handle,
 * callbackUrl} is the PRIMARY browser OAuth flow (enterprises commonly
 * block device auth — Chad's workspace does; 2026-10-18 live).
 * {action:"paste", authJson} is the fallback for when the whole
 * browser round-trip is impractical (run `codex login` on any machine
 * with a browser, paste the auth.json it writes); DELETE logs out.
 * Every success carries the credential's status shape only — tokens
 * never cross this boundary.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
    authJson?: unknown;
    handle?: unknown;
    callbackUrl?: unknown;
  };

  if (body.action === "browser_start") {
    return NextResponse.json(startCodexBrowserLogin());
  }

  if (body.action === "browser_complete") {
    const handle = parseBrowserHandle(body.handle);
    if (!handle || typeof body.callbackUrl !== "string" || !body.callbackUrl.trim()) {
      return NextResponse.json({ error: "expected {action: \"browser_complete\", handle, callbackUrl}" }, { status: 400 });
    }
    const result = await completeCodexBrowserLogin(handle, body.callbackUrl);
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 502 });
    const { expiresAt, accountId } = result.credential;
    return NextResponse.json({ ok: true, credential: { configured: true, expiresAt, accountId } });
  }

  if (body.action === "paste" && typeof body.authJson === "string" && body.authJson.trim()) {
    const saved = saveCodexCredential(body.authJson);
    if (!saved.ok) return NextResponse.json({ error: saved.message }, { status: 400 });
    const { expiresAt, accountId } = saved;
    return NextResponse.json({ ok: true, credential: { configured: true, expiresAt, accountId } });
  }

  return NextResponse.json(
    { error: 'expected {action: "browser_start" | "browser_complete" | "paste"}' },
    { status: 400 },
  );
}

function parseBrowserHandle(value: unknown): CodexBrowserHandle | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const codeVerifier = typeof v.codeVerifier === "string" && v.codeVerifier;
  const state = typeof v.state === "string" && v.state;
  const redirectUri = typeof v.redirectUri === "string" && v.redirectUri;
  if (!codeVerifier || !state || !redirectUri) return null;
  return { codeVerifier, state, redirectUri };
}

export async function DELETE() {
  clearCodexCredential();
  return NextResponse.json({ ok: true });
}
