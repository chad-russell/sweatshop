import { NextResponse } from "next/server";
import { db } from "@/db";
import { renameProject } from "@/db/projects";
import { deleteProjectFully } from "@/lib/projects";

export const dynamic = "force-dynamic";

/**
 * 0018 phase 3: one project. PATCH renames it; DELETE runs the
 * approved cascade — cancel live runs, destroy live sandboxes, then
 * every row the project owns (conversations hard-deleted; typed-name
 * confirmation lives in the UI, the danger zone card).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  if (typeof body.name !== "string") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const result = renameProject(db(), projectId, body.name);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.code === "not-found" ? 404 : 400 });
  }
  return NextResponse.json({ name: result.name });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const result = await deleteProjectFully(projectId);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.code === "not-found" ? 404 : 409 });
  }
  return NextResponse.json({ deleted: true, counts: result.counts });
}
