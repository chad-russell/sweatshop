import { NextResponse } from "next/server";
import { listCatalog } from "@/lib/skills/catalog-source";

export const dynamic = "force-dynamic";

/** 0090 §7: a source's skill list (git-trees browse, 10-min cached). */
export async function GET(request: Request) {
  const source = new URL(request.url).searchParams.get("source") ?? "anthropics";
  return NextResponse.json(await listCatalog(source));
}
