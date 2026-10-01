import { NextResponse } from "next/server";
import { db } from "@/db";
import { searchConversations } from "@/db/search";

export const dynamic = "force-dynamic";

/**
 * Conversation search (0003 + 0007):
 * `GET /api/search?q=…[&project=<id>|none][&folder=<id>][&archived=0]`.
 */
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q") ?? "";
  try {
    return NextResponse.json({
      results: searchConversations(db(), query, {
        project: params.get("project") ?? undefined,
        folder: params.get("folder") ?? undefined,
        includeArchived: params.get("archived") !== "0",
      }),
    });
  } catch (err) {
    // Search must never break the sidebar; empty results on failure.
    console.error("[search] failed", err);
    return NextResponse.json({ results: [] }, { status: 500 });
  }
}
