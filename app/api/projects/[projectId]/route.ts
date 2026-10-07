import { NextResponse } from "next/server";
import { db } from "@/db";
import { renameProject, setProjectImage } from "@/db/projects";
import { deleteProjectFully } from "@/lib/projects";

export const dynamic = "force-dynamic";

/**
 * 0018 phase 3 / 0031: one project. PATCH renames it and/or sets its
 * sandbox image (`imageRef`: string to set, null/"" to clear — applies
 * to the project's next sandbox). DELETE runs the approved cascade —
 * cancel live runs, destroy live sandboxes, then every row the project
 * owns (conversations hard-deleted; typed-name confirmation lives in
 * the UI, the danger zone card).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown;
    imageRef?: unknown;
  };
  if (body.name === undefined && body.imageRef === undefined) {
    return NextResponse.json({ error: "name or imageRef is required" }, { status: 400 });
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    return NextResponse.json({ error: "name must be a string" }, { status: 400 });
  }
  if (
    body.imageRef !== undefined &&
    body.imageRef !== null &&
    typeof body.imageRef !== "string"
  ) {
    return NextResponse.json({ error: "imageRef must be a string or null" }, { status: 400 });
  }

  if (typeof body.name === "string") {
    const result = renameProject(db(), projectId, body.name);
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.code === "not-found" ? 404 : 400 });
    }
  }
  if (body.imageRef !== undefined) {
    const result = setProjectImage(db(), projectId, body.imageRef as string | null);
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.code === "not-found" ? 404 : 400 });
    }
    return NextResponse.json({ ok: true, imageRef: result.imageRef });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const result = await deleteProjectFully(projectId);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.code === "not-found" ? 404 : 409 });
  }
  return NextResponse.json({ deleted: true, counts: result.counts });
}
