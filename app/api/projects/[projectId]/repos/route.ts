import { NextResponse } from "next/server";
import { db } from "@/db";
import { addProjectRepo, removeProjectRepo } from "@/db/projects";

export const dynamic = "force-dynamic";

/**
 * 0018 phase 3: a project's repos. POST { name, url } adds one
 * (unique name per project); DELETE ?repoId= removes one — guarded:
 * it refuses with named blockers while the preview setup targets it
 * or previews reference it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; url?: unknown };
  if (typeof body.name !== "string" || typeof body.url !== "string") {
    return NextResponse.json({ error: "name and url are required" }, { status: 400 });
  }
  const result = addProjectRepo(db(), projectId, { name: body.name, url: body.url });
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.code === "not-found" ? 404 : result.code === "conflict" ? 409 : 400 });
  }
  return NextResponse.json({ repoId: result.repoId });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const repoId = new URL(request.url).searchParams.get("repoId");
  if (!repoId) return NextResponse.json({ error: "repoId is required" }, { status: 400 });
  const result = removeProjectRepo(db(), projectId, repoId);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.code === "not-found" ? 404 : 409 });
  }
  return NextResponse.json({ removed: true });
}
