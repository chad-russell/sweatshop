import { NextResponse } from "next/server";
import { destroySandboxNow, SandboxActionError, stopSandboxNow } from "@/lib/sandboxes/reaper";

export const dynamic = "force-dynamic";

/** 0013: manual lifecycle for one sandbox — `{ action: "stop" | "destroy" }`. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  try {
    if (body.action === "stop") await stopSandboxNow(id);
    else if (body.action === "destroy") await destroySandboxNow(id);
    else return NextResponse.json({ error: 'action must be "stop" or "destroy"' }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SandboxActionError) {
      const status = err.code === "not-found" ? 404 : err.code === "busy" ? 409 : 400;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
