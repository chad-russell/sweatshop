import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  deletePreviewSetup,
  getPreviewSetup,
  savePreviewSetup,
} from "@/db/preview-setups";

export const dynamic = "force-dynamic";

/**
 * 0017: the project's preview setup (static segment — beats the [id]
 * route). GET `?projectId=` returns the parsed definition (null when
 * none); PUT `{ projectId, definition }` upserts it (issues
 * value-shaped); DELETE `?projectId=` drops it (a fresh Discover starts
 * over). Values are masked nowhere here — this is the LAN-only editor
 * API; the UI masks in list views.
 */
export async function GET(request: Request) {
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  const result = getPreviewSetup(db(), projectId);
  if (!result.ok) return NextResponse.json({ error: result.issues.join("; ") }, { status: 409 });
  return NextResponse.json({ setup: result.setup });
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { projectId?: string; definition?: unknown };
  if (!body.projectId || !body.definition || typeof body.definition !== "object") {
    return NextResponse.json({ error: "projectId and definition are required" }, { status: 400 });
  }
  const saved = savePreviewSetup(db(), body.projectId, body.definition);
  if (!saved.ok) return NextResponse.json({ error: saved.issues.join("; ") }, { status: 400 });
  return NextResponse.json({ setup: saved.setup });
}

export async function DELETE(request: Request) {
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  return NextResponse.json({ deleted: deletePreviewSetup(db(), projectId) });
}
