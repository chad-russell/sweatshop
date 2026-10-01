import { NextResponse } from "next/server";
import { db } from "@/db";
import { createFolder } from "@/db/organize";
import {
  nullableString,
  organizeErrorResponse,
  readBody,
} from "@/lib/api-organize";

export const dynamic = "force-dynamic";

/** Create a folder (0007): `{ name, projectId?: string|null, parentId?: string|null }`. */
export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const folder = createFolder(db(), {
      name: typeof body.name === "string" ? body.name : "",
      projectId: nullableString(body, "projectId") ?? null,
      parentId: nullableString(body, "parentId") ?? null,
    });
    return NextResponse.json({ folder }, { status: 201 });
  } catch (err) {
    return organizeErrorResponse(err);
  }
}
