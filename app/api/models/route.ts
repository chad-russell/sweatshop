import { NextResponse } from "next/server";
import { db } from "@/db";
import { modelsView } from "@/lib/providers/catalog-view";
import { ensureOpenRouterCatalog } from "@/lib/providers/openrouter";
import { ensureModelPrices } from "@/lib/usage/prices-refresh";

export const dynamic = "force-dynamic";

/**
 * 0021: the model catalog pickers read — providers (available, allowed),
 * their models, claude, and the effective global defaults.
 * `?projectId=` applies that project's restrictions. The OpenRouter
 * catalog refreshes lazily here (at most daily; a failure keeps the
 * cached list).
 */
export async function GET(request: Request) {
  const projectId = new URL(request.url).searchParams.get("projectId");
  await ensureOpenRouterCatalog(db());
  await ensureModelPrices(db());
  return NextResponse.json(modelsView(db(), projectId));
}
