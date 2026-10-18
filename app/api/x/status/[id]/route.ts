import { NextResponse } from "next/server";
import { db } from "@/db";
import { childStatus } from "@/lib/child-status";

export const dynamic = "force-dynamic";

/** A background child's status (hc_… harness call or c_… child thread) —
 *  what a transcript card polls while the child is live. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const status = childStatus(db(), id);
  if (!status) return NextResponse.json({ error: `no harness call or child thread ${id}` }, { status: 404 });
  return NextResponse.json(status);
}
