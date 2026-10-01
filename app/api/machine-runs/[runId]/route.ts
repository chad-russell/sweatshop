import { NextResponse } from "next/server";
import { db } from "@/db";
import { getRun, listStageRuns } from "@/db/machines";
import { machineErrorResponse } from "@/lib/machines/api";

export const dynamic = "force-dynamic";

/** A run and its stage visits (the run view polls this). */
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    return NextResponse.json({ run: getRun(db(), runId), visits: listStageRuns(db(), runId) });
  } catch (err) {
    return machineErrorResponse(err);
  }
}
