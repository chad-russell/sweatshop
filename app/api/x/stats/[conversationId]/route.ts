import { NextResponse } from "next/server";
import { db } from "@/db";
import { OrganizeError } from "@/db/organize";
import { readConversationStats } from "@/lib/usage/stats";

export const dynamic = "force-dynamic";

/** 0047: the stats drawer — the conversation's group, metered on request. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;
  try {
    return NextResponse.json(readConversationStats(db(), conversationId));
  } catch (err) {
    if (err instanceof OrganizeError && err.code === "not-found") {
      return NextResponse.json({ error: "not-found" }, { status: 404 });
    }
    throw err;
  }
}
