import { NextResponse } from "next/server";
import { machineErrorResponse } from "@/lib/machines/api";
import { cancelRun } from "@/lib/machines/runs";

export const dynamic = "force-dynamic";

/** Stop a live run (0012): `{ cancelled }` is false when it was not live. */
export async function POST(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    return NextResponse.json({ cancelled: await cancelRun(runId) });
  } catch (err) {
    return machineErrorResponse(err);
  }
}
