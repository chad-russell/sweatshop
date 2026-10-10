import { NextResponse } from "next/server";
import { db } from "@/db";
import { getRun, listStageRuns, MachineError } from "@/db/machines";

export const dynamic = "force-dynamic";

/** A historical run and its stage visits (read-only since 0037 phase 5). */
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    return NextResponse.json({ run: getRun(db(), runId), visits: listStageRuns(db(), runId) });
  } catch (err) {
    if (err instanceof MachineError && err.code === "not-found") {
      return NextResponse.json({ error: `run ${err.message}` }, { status: 404 });
    }
    throw err;
  }
}
