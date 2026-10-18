import { NextResponse } from "next/server";
import { startCodexDeviceLogin } from "@/lib/harness-auth/codex-login";

export const dynamic = "force-dynamic";

/**
 * 0050 phase 5: begin the codex device login — asks the issuer for a
 * user code and hands the browser everything it renders (code,
 * verification URL) plus the stateless polling handle it posts back to
 * /poll. No session is kept server-side.
 */
export async function POST() {
  const result = await startCodexDeviceLogin();
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 502 });
  return NextResponse.json(result);
}
