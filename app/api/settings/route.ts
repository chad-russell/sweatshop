import { NextResponse } from "next/server";
import { db } from "@/db";
import { modelsView } from "@/lib/providers/catalog-view";
import { setDefaultRoute } from "@/lib/providers/settings";

export const dynamic = "force-dynamic";

/** 0021: the settings page's data — the models view (defaults included). */
export async function GET() {
  return NextResponse.json(modelsView(db()));
}

/**
 * 0021: set one surface's default route — `{ surface, route }`, route
 * null resets to the built-in default. Effective on the next turn/visit.
 */
export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { surface?: unknown; route?: unknown };
  const result = setDefaultRoute(db(), body.surface, body.route === undefined ? undefined : body.route);
  if (!result.ok) {
    return NextResponse.json({ error: result.issues.join("; "), issues: result.issues }, { status: 400 });
  }
  return NextResponse.json({ ok: true, defaults: modelsView(db()).defaults });
}
