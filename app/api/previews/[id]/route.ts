import { NextResponse } from "next/server";
import { db } from "@/db";
import { getPreview, listPreviewEvents } from "@/db/previews";
import { confirmBranchPreview, discoverForPreview, removePreview } from "@/lib/previews/branch";
import { dismissPreviewFailure, retryPreview } from "@/lib/previews/follow";
import { parsePreviewOverrides } from "@/lib/previews/overrides";
import {
  launchPreview,
  previewEnvView,
  previewLogs,
  PreviewError,
  stopPreview,
  viewPreview,
} from "@/lib/previews/service";

export const dynamic = "force-dynamic";

/** 0016: one preview, with `?logs=<n>` for its server log tail.
 * 0017: `?candidates=1` runs the Discover scan on a provisioning row;
 * `?env=1` adds the resolved env with values masked. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  if (url.searchParams.get("candidates") === "1") {
    const result = await discoverForPreview(id);
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json(result);
  }
  const p = getPreview(db(), id);
  if (!p) return NextResponse.json({ error: `no preview ${id}` }, { status: 404 });
  const lines = Number(url.searchParams.get("logs") ?? 0);
  const log = lines > 0 ? await previewLogs(id, lines).catch(() => "") : undefined;
  const env = url.searchParams.get("env") === "1" ? previewEnvView(id) : undefined;
  return NextResponse.json({
    preview: viewPreview(p),
    events: listPreviewEvents(db(), id),
    ...(log !== undefined ? { log } : {}),
    ...(env !== undefined ? env : {}),
  });
}

/**
 * 0017/0019: `{ action }` — "confirm" (a provisioning preview gets its
 * values: with no saved setup they become the project's first; with
 * one they are this preview's own and setup-level fields — migrate,
 * seed, services — are refused; then install + launch), "restart" (relaunch the process), "stop",
 * "delete" (a branch preview destroys its own sandbox), and for branch
 * previews "retry" (forget the failure and redeploy the remote head —
 * a create-time failure re-provisions) and "dismiss" (hide this
 * failing sha's Inbox item).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (body.action === "confirm") {
      const parsed = parsePreviewOverrides(body);
      if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
      return NextResponse.json(await confirmBranchPreview(id, parsed.overrides));
    }
    if (body.action === "restart") {
      const { preview, log } = await launchPreview(id, { healthTimeoutMs: 20_000 });
      return NextResponse.json({ preview, ...(log ? { log } : {}) });
    }
    if (body.action === "stop") return NextResponse.json({ preview: await stopPreview(id) });
    if (body.action === "delete") {
      await removePreview(id);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "retry") return NextResponse.json({ report: await retryPreview(id) });
    if (body.action === "dismiss") {
      dismissPreviewFailure(id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json(
      { error: 'action must be "confirm", "restart", "stop", "delete", "retry" or "dismiss"' },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof PreviewError) {
      const status = err.code === "not-found" ? 404 : err.code === "invalid" ? 400 : 409;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
