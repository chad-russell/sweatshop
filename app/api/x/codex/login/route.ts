import { NextResponse } from "next/server";
import { clearCodexCredential, saveCodexCredential } from "@/lib/harness-auth/codex";

export const dynamic = "force-dynamic";

/**
 * 0050 phase 5: the codex login's account-level verbs. POST
 * {action:"paste", authJson} is the documented fallback for when
 * device-code login is blocked (run `codex login` on any machine with
 * a browser, paste the auth.json it writes); DELETE logs out. Both end
 * at the same file — the file is the seam.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; authJson?: unknown };
  if (body.action !== "paste" || typeof body.authJson !== "string" || !body.authJson.trim()) {
    return NextResponse.json({ error: "expected {action: \"paste\", authJson: string}" }, { status: 400 });
  }
  const saved = saveCodexCredential(body.authJson);
  if (!saved.ok) return NextResponse.json({ error: saved.message }, { status: 400 });
  const { expiresAt, accountId } = saved;
  return NextResponse.json({ ok: true, credential: { configured: true, expiresAt, accountId } });
}

export async function DELETE() {
  clearCodexCredential();
  return NextResponse.json({ ok: true });
}
