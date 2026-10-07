import { NextResponse } from "next/server";
import { db } from "@/db";
import { listRuns } from "@/db/machines";
import { machineErrorResponse, readMachineBody } from "@/lib/machines/api";
import { startRun } from "@/lib/machines/runs";

export const dynamic = "force-dynamic";

/** List recent runs: `?projectId=&machineId=&limit=`. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  return NextResponse.json({
    runs: listRuns(db(), {
      projectId: url.searchParams.get("projectId") ?? undefined,
      machineId: url.searchParams.get("machineId") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 50) || 50,
    }),
  });
}

/** Start a run (0009): `{ machineId, prompt, projectId?, overrides? }` (0021 route overrides). */
export async function POST(request: Request) {
  try {
    const body = await readMachineBody(request);
    const run = await startRun({
      machineId: typeof body.machineId === "string" ? body.machineId : "",
      prompt: body.prompt,
      projectId: body.projectId,
      overrides: body.overrides,
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    return machineErrorResponse(err);
  }
}
