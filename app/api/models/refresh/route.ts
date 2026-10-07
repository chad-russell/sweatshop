import { NextResponse } from "next/server";
import { db } from "@/db";
import { refreshOpenRouterCatalog } from "@/lib/providers/openrouter";

export const dynamic = "force-dynamic";

/** 0021: "Refresh models" on /settings — refetch the OpenRouter catalog now. */
export async function POST() {
  const result = await refreshOpenRouterCatalog(db());
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json(result);
}
