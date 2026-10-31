import { NextResponse } from "next/server";
import { deleteSkill } from "@/lib/skills/store";

export const dynamic = "force-dynamic";

/** 0090 §5: remove a skill's object family — value-shaped StoreResult out. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await deleteSkill(id));
}
