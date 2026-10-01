import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { db } from "@/db";
import { createRun, listRuns, updateRun } from "@/db/machines";
import { machineErrorResponse, readMachineBody } from "@/lib/machines/api";
import { runMachine } from "@/workflows/machines/run-machine";

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

/** Start a run (0009): `{ machineId, prompt, projectId? }`. */
export async function POST(request: Request) {
  try {
    const body = await readMachineBody(request);
    const run = createRun(db(), {
      machineId: typeof body.machineId === "string" ? body.machineId : "",
      prompt: body.prompt,
      projectId: body.projectId,
    });
    try {
      await start(runMachine, [
        { runId: run.id, definition: run.definition, prompt: run.prompt, projectId: run.projectId },
      ]);
    } catch (err) {
      updateRun(db(), run.id, { status: "failed", error: `could not start: ${String(err)}` });
      throw err;
    }
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    return machineErrorResponse(err);
  }
}
