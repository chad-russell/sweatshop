import { NextResponse } from "next/server";
import { db } from "@/db";
import { createMachine, listMachines } from "@/db/machines";
import { machineErrorResponse, readMachineBody } from "@/lib/machines/api";

export const dynamic = "force-dynamic";

/** List machines (0009). */
export async function GET() {
  try {
    return NextResponse.json({ machines: listMachines(db()) });
  } catch (err) {
    return machineErrorResponse(err);
  }
}

/** Create a machine: `{ id?, name, description?, definition }`. */
export async function POST(request: Request) {
  try {
    const body = await readMachineBody(request);
    const machine = createMachine(db(), {
      id: body.id,
      name: body.name,
      description: body.description,
      definition: body.definition,
    });
    return NextResponse.json({ machine }, { status: 201 });
  } catch (err) {
    return machineErrorResponse(err);
  }
}
