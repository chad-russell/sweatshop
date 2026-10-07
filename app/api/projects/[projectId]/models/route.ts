import { NextResponse } from "next/server";
import { db } from "@/db";
import { getProjectModels } from "@/db/providers";
import { setProjectModelSettings } from "@/lib/providers/settings";

export const dynamic = "force-dynamic";

/** 0021: a project's model settings (default route, allowed providers/harnesses). */
export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const models = getProjectModels(db(), projectId);
  if (!models) return NextResponse.json({ error: `project ${projectId} not found` }, { status: 404 });
  return NextResponse.json(models);
}

/**
 * PATCH `{ defaultRoute?, allowedProviders?, allowedHarnesses? }` — each
 * absent = untouched, null = clear. Rejected (with issues) when the
 * default route would not be allowed or available.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = setProjectModelSettings(db(), projectId, {
    defaultRoute: body.defaultRoute,
    allowedProviders: body.allowedProviders,
    allowedHarnesses: body.allowedHarnesses,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.issues.join("; "), issues: result.issues },
      { status: result.notFound ? 404 : 400 },
    );
  }
  return NextResponse.json(result.models);
}
