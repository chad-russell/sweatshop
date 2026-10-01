import { NextResponse } from "next/server";
import { db } from "@/db";
import { loadAttention } from "@/db/attention";

export const dynamic = "force-dynamic";

/**
 * 0008: the cheap poll target. Returns the attention signature (see
 * AttentionState.signature); the sidebar refreshes the server-rendered
 * layout only when it differs from the one it last rendered.
 */
export function GET() {
  const { signature } = loadAttention(db());
  return NextResponse.json({ signature }, { headers: { "cache-control": "no-store" } });
}
