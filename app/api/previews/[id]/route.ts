import { NextResponse } from "next/server";
import { db } from "@/db";
import { getPreview, listPreviewEvents } from "@/db/previews";
import {
  confirmBranchPreview,
  discoverForPreview,
  dismissPreviewFailure,
  removePreview,
  retryPreview,
} from "@/lib/previews/branch";
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
 * 0017: `{ action }` — "confirm" (a provisioning preview gets its
 * chosen values; structural fields — workDir, install, provision,
 * seed, services, env — always save to the project's setup, then
 * install + launch), "restart" (relaunch the process), "stop",
 * "delete" (a branch preview destroys its own sandbox), and for branch
 * previews "retry" (forget the failure and redeploy the remote head —
 * a create-time failure re-provisions) and "dismiss" (hide this
 * failing sha's Inbox item).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (k: string) =>
    typeof body[k] === "string" && (body[k] as string).trim() ? (body[k] as string).trim() : undefined;
  try {
    if (body.action === "confirm") {
      const port = body.port === undefined || body.port === "" ? undefined : Number(body.port);
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
        return NextResponse.json({ error: "port must be 1–65535" }, { status: 400 });
      }
      let env: Record<string, string> | undefined;
      if (body.env !== undefined) {
        if (typeof body.env !== "object" || body.env === null || Array.isArray(body.env)) {
          return NextResponse.json({ error: "env must be an object of KEY → string" }, { status: 400 });
        }
        const entries = Object.entries(body.env as Record<string, unknown>);
        if (entries.some(([, v]) => typeof v !== "string")) {
          return NextResponse.json({ error: "env values must be strings" }, { status: 400 });
        }
        env = Object.fromEntries(entries as [string, string][]);
      }
      let services: unknown[] | undefined;
      if (body.services !== undefined) {
        if (!Array.isArray(body.services)) {
          return NextResponse.json({ error: "services must be an array" }, { status: 400 });
        }
        services = body.services;
      }
      const result = await confirmBranchPreview(id, {
        ...(str("workDir") ? { workDir: str("workDir") } : {}),
        ...(str("install") ? { install: str("install") } : {}),
        ...(str("command") ? { command: str("command") } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(str("label") ? { label: str("label") } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(str("provision") ? { provision: str("provision") } : {}),
        ...(str("seed") ? { seed: str("seed") } : {}),
        ...(services !== undefined ? { services: services as never } : {}),
      });
      return NextResponse.json(result);
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
