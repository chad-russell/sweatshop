import { NextResponse } from "next/server";
import { db } from "@/db";
import { refreshOpenRouterCatalog } from "@/lib/providers/openrouter";
import { ensureModelPrices } from "@/lib/usage/prices-refresh";

export const dynamic = "force-dynamic";

/** 0021: "Refresh models" on /settings — refetch the OpenRouter catalog now. */
export async function POST() {
  const [result] = await Promise.all([refreshOpenRouterCatalog(db()), ensureModelPrices(db())]);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json(result);
}
