import { NextResponse } from "next/server";
import { db } from "@/db";
import { addProjectHost, removeProjectHost } from "@/db/hosts";

export const dynamic = "force-dynamic";

/**
 * 0043: a project's host allow-list. POST { name, address, user,
 * apiBase? } adds one (unique name per project); DELETE ?hostId=
 * removes one — audit history survives the removal. Credentials never
 * pass through here: they live in the app's env (HOST_<NAME>_…).
 */
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown;
    address?: unknown;
    user?: unknown;
    apiBase?: unknown;
  };
  if (typeof body.name !== "string" || typeof body.address !== "string" || typeof body.user !== "string") {
    return NextResponse.json({ error: "name, address and user are required" }, { status: 400 });
  }
  const result = addProjectHost(db(), projectId, {
    name: body.name,
    address: body.address,
    user: body.user,
    ...(typeof body.apiBase === "string" && body.apiBase.trim() ? { apiBase: body.apiBase } : {}),
  });
  if (!result.ok) {
    const status = result.code === "not-found" ? 404 : result.code === "conflict" ? 409 : 400;
    return NextResponse.json({ error: result.message }, { status });
  }
  return NextResponse.json({ hostId: result.host.id });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const hostId = new URL(request.url).searchParams.get("hostId");
  if (!hostId) return NextResponse.json({ error: "hostId is required" }, { status: 400 });
  const result = removeProjectHost(db(), projectId, hostId);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.code === "not-found" ? 404 : 409 });
  }
  return NextResponse.json({ removed: true });
}
