import { NextResponse } from "next/server";
import { setSkillDisabled } from "@/lib/skills/store";

export const dynamic = "force-dynamic";

/**
 * 0090 §5: disable/enable a skill — `{ disabled: boolean }` in, the
 * value-shaped StoreResult out. Only a malformed body 400s; an unknown
 * id or a down store is a 200 value (the /api/settings/test convention).
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { disabled?: unknown };
  if (typeof body.disabled !== "boolean") {
    return NextResponse.json({ error: "disabled must be a boolean" }, { status: 400 });
  }
  return NextResponse.json(await setSkillDisabled(id, body.disabled));
}
