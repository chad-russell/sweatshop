import { NextResponse } from "next/server";
import { db } from "@/db";
import { deleteMachine, getMachine, updateMachine } from "@/db/machines";
import { machineErrorResponse, readMachineBody } from "@/lib/machines/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  try {
    return NextResponse.json({ machine: getMachine(db(), (await params).id) });
  } catch (err) {
    return machineErrorResponse(err);
  }
}

/** Patch `{ name?, description?, definition? }`; definition changes bump version. */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const body = await readMachineBody(request);
    const machine = updateMachine(db(), (await params).id, {
      name: body.name,
      description: body.description,
      definition: body.definition,
    });
    return NextResponse.json({ machine });
  } catch (err) {
    return machineErrorResponse(err);
  }
}

/** Delete a machine; its runs keep their definition snapshots. */
export async function DELETE(_request: Request, { params }: Ctx) {
  try {
    deleteMachine(db(), (await params).id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return machineErrorResponse(err);
  }
}
