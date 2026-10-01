import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { sandboxes } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * 0010: running sandboxes for the composer's attach dropdown — the
 * explicit "join another owner's sandbox" escape hatch (docs/0010).
 */
export async function GET() {
  const rows = db()
    .select({
      id: sandboxes.id,
      ownerKind: sandboxes.ownerKind,
      ownerId: sandboxes.ownerId,
      projectId: sandboxes.projectId,
      ref: sandboxes.ref,
    })
    .from(sandboxes)
    .where(and(eq(sandboxes.status, "running")))
    .all();
  return NextResponse.json({ sandboxes: rows });
}
