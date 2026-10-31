import { NextResponse } from "next/server";
import { searchCatalogs } from "@/lib/skills/catalog-source";

export const dynamic = "force-dynamic";

/** 0091 §1: federated search over SkillsMP — a directory of public
 * skill repos; content still comes from GitHub at a pinned sha. */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });
  return NextResponse.json(await searchCatalogs(q));
}
