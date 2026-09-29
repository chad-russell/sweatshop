import { NextResponse } from "next/server";
import { db } from "@/db";
import { searchConversations } from "@/db/search";

export const dynamic = "force-dynamic";

/** Conversation full-text search (0003): `GET /api/search?q=...`. */
export function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q") ?? "";
  try {
    return NextResponse.json({ results: searchConversations(db(), query) });
  } catch (err) {
    // Search must never break the sidebar; empty results on failure.
    console.error("[search] failed", err);
    return NextResponse.json({ results: [] }, { status: 500 });
  }
}
