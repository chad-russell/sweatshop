import { NextResponse } from "next/server";
import { db } from "@/db";
import { setProjectSandboxConfig, updateSandboxConfig } from "@/db/projects";

export const dynamic = "force-dynamic";

/**
 * 0018 phase 3: the project's sandbox config. PATCH
 * `{ configId: string | null, imageRef?, networkPolicy? }` — picking
 * none/existing and editing the referenced config's fields (shared:
 * every project on it changes; creating configs stays db:seed v1).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    configId?: unknown;
    imageRef?: unknown;
    networkPolicy?: unknown;
  };
  if (body.configId !== undefined && body.configId !== null && typeof body.configId !== "string") {
    return NextResponse.json({ error: "configId must be a string or null" }, { status: 400 });
  }
  const configId: string | null = typeof body.configId === "string" ? body.configId : null;
  const picked = await (async () => {
    const result = setProjectSandboxConfig(db(), projectId, configId);
    if (!result.ok) return result;
    if (result.configId && (typeof body.imageRef === "string" || typeof body.networkPolicy === "string")) {
      return updateSandboxConfig(db(), result.configId, {
        ...(typeof body.imageRef === "string" ? { imageRef: body.imageRef } : {}),
        ...(typeof body.networkPolicy === "string" ? { networkPolicy: body.networkPolicy } : {}),
      });
    }
    return result;
  })();
  if (!picked.ok) {
    return NextResponse.json({ error: picked.message }, { status: picked.code === "not-found" ? 404 : 400 });
  }
  return NextResponse.json({
    ok: true,
    ...("configId" in picked ? { configId: picked.configId } : {}),
    ...("sharedWith" in picked ? { sharedWith: picked.sharedWith } : {}),
  });
}
