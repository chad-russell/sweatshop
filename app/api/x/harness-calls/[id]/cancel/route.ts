import { NextResponse } from "next/server";
import { cancelRunTool } from "@/lib/agent/tools/cancel-run";

export const dynamic = "force-dynamic";

/**
 * 0063: the session/card Cancel button's route — the same settle-now,
 * teardown-at-next-boundary semantics as the agent's own `cancel_run`
 * tool (lib/agent/tools/cancel-run.ts), scoped to background harness
 * calls (hc_…) only; child threads (c_…) are not this button's business.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id.startsWith("hc_")) {
    return NextResponse.json(
      { ok: false, code: "not-found", message: `${id} is not a harness call id (hc_…)` },
      { status: 400 },
    );
  }
  const result = await cancelRunTool(id);
  if (!result.ok) {
    const status = result.code === "not-found" ? 404 : result.code === "not-live" ? 409 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result, { status: 200 });
}
