import { NextResponse } from "next/server";
import { db } from "@/db";
import { getPreview } from "@/db/previews";
import {
  launchPreview,
  previewLogs,
  PreviewError,
  stopPreview,
  viewPreview,
} from "@/lib/previews/service";

export const dynamic = "force-dynamic";

/** 0016: one preview, with `?logs=<n>` for its server log tail. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = getPreview(db(), id);
  if (!p) return NextResponse.json({ error: `no preview ${id}` }, { status: 404 });
  const lines = Number(new URL(request.url).searchParams.get("logs") ?? 0);
  const log = lines > 0 ? await previewLogs(id, lines).catch(() => "") : undefined;
  return NextResponse.json({ preview: viewPreview(p), ...(log !== undefined ? { log } : {}) });
}

/** 0016: `{ action: "restart" | "stop" | "delete" }`. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  try {
    if (body.action === "restart") {
      const { preview, log } = await launchPreview(id, { healthTimeoutMs: 20_000 });
      return NextResponse.json({ preview, ...(log ? { log } : {}) });
    }
    if (body.action === "stop") return NextResponse.json({ preview: await stopPreview(id) });
    if (body.action === "delete") {
      const { removePreview } = await import("@/lib/previews/branch");
      await removePreview(id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'action must be "restart", "stop" or "delete"' }, { status: 400 });
  } catch (err) {
    if (err instanceof PreviewError) {
      const status = err.code === "not-found" ? 404 : err.code === "invalid" ? 400 : 409;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}

