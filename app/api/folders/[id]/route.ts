import { NextResponse } from "next/server";
import { db } from "@/db";
import { deleteFolder, moveFolder, renameFolder } from "@/db/organize";
import {
  nullableString,
  organizeErrorResponse,
  readBody,
} from "@/lib/api-organize";

export const dynamic = "force-dynamic";

/** Rename and/or re-parent a folder: `{ name?, parentId?: string|null }`. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await readBody(request);
    if (typeof body.name === "string") renameFolder(db(), id, body.name);
    const parentId = nullableString(body, "parentId");
    if (parentId !== undefined) moveFolder(db(), id, parentId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return organizeErrorResponse(err);
  }
}

/** Delete a folder; its contents move up one level. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    deleteFolder(db(), id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return organizeErrorResponse(err);
  }
}
