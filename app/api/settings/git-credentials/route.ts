import { NextResponse } from "next/server";
import { db } from "@/db";
import { createGitCredential, listGitCredentialViews, updateGitCredential } from "@/lib/git-hosts/credential-admin";

export const dynamic = "force-dynamic";

/** Stored git-host credentials, secrets reduced to a start/end hint. */
export async function GET() {
  return NextResponse.json({ credentials: listGitCredentialViews(db()) });
}

/** Add a credential — `{kind, username, secret, label?, baseUrl?}`. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = createGitCredential(db(), body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ credentials: listGitCredentialViews(db()) });
}

/** Replace a token — `{id, secret, username?}`. */
export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; secret?: unknown; username?: unknown };
  const result = updateGitCredential(db(), body.id, body.secret, body.username);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ credentials: listGitCredentialViews(db()) });
}
