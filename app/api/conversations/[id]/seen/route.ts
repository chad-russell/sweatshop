import { NextResponse } from "next/server";
import { db } from "@/db";
import { markSeen, markUnread } from "@/db/attention";
import { optionalBoolean, organizeErrorResponse, readBody } from "@/lib/api-organize";

export const dynamic = "force-dynamic";

/**
 * 0008: read state for one conversation. `{ seen: true }` marks it viewed
 * now (what opening it does); `{ seen: false }` marks it unread again.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await readBody(request);
    const seen = optionalBoolean(body, "seen") ?? true;
    // `changed`: the unread state flipped (so the caller should refresh).
    const changed = seen ? markSeen(db(), id) : markUnread(db(), id);
    return NextResponse.json({ ok: true, changed });
  } catch (err) {
    return organizeErrorResponse(err);
  }
}
