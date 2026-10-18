import { NextResponse } from "next/server";
import { pollCodexDeviceLogin, type CodexLoginHandle } from "@/lib/harness-auth/codex-login";

export const dynamic = "force-dynamic";

/**
 * 0050 phase 5: one issuer poll per browser poll — the client holds the
 * handle from /start and posts it back; the server stays stateless.
 * Approved returns ONLY the credential's status shape (configured,
 * expiry, account id) — tokens never cross this boundary.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { handle?: unknown };
  const handle = parseHandle(body.handle);
  if (!handle) return NextResponse.json({ error: "the login handle from /start is required" }, { status: 400 });
  const result = await pollCodexDeviceLogin(handle);
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 502 });
  if (result.status === "approved") {
    const { expiresAt, accountId } = result.credential;
    return NextResponse.json({ status: "approved", credential: { configured: true, expiresAt, accountId } });
  }
  return NextResponse.json(result);
}

function parseHandle(value: unknown): CodexLoginHandle | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const deviceAuthId = typeof v.deviceAuthId === "string" && v.deviceAuthId;
  const userCode = typeof v.userCode === "string" && v.userCode;
  const interval = typeof v.interval === "number" && v.interval > 0 ? v.interval : 0;
  const expiresAt = typeof v.expiresAt === "number" ? v.expiresAt : 0;
  if (!deviceAuthId || !userCode || !interval || !expiresAt) return null;
  return { deviceAuthId, userCode, interval, expiresAt };
}
