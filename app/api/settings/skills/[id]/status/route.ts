import { NextResponse } from "next/server";
import { INVOKE_MODES, setSkillDisabled, setSkillInvokeMode, type InvokeMode } from "@/lib/skills/store";

export const dynamic = "force-dynamic";

/**
 * 0090 §5 / 0091 §2: disable/enable a skill and set its invocation
 * mode — `{ disabled?: boolean, invoke?: "auto"|"tool"|"manual" }` in
 * (at least one field), the value-shaped StoreResults out. Only a
 * malformed body 400s; an unknown id or a down store is a 200 value
 * (the /api/settings/test convention). When both fields are present
 * the disable applies first, then the mode, on fresh reads.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { disabled?: unknown; invoke?: unknown };
  const hasDisabled = body.disabled !== undefined;
  const hasInvoke = body.invoke !== undefined;
  if (!hasDisabled && !hasInvoke) {
    return NextResponse.json({ error: "body needs `disabled` (boolean) or `invoke` (auto|tool|manual)" }, { status: 400 });
  }
  if (hasDisabled && typeof body.disabled !== "boolean") {
    return NextResponse.json({ error: "disabled must be a boolean" }, { status: 400 });
  }
  if (hasInvoke && (typeof body.invoke !== "string" || !(INVOKE_MODES as readonly string[]).includes(body.invoke))) {
    return NextResponse.json({ error: "invoke must be one of auto, tool, manual" }, { status: 400 });
  }
  if (hasDisabled) {
    const res = await setSkillDisabled(id, body.disabled as boolean);
    if (!res.ok) return NextResponse.json(res);
  }
  if (hasInvoke) {
    const res = await setSkillInvokeMode(id, body.invoke as InvokeMode);
    if (!res.ok) return NextResponse.json(res);
  }
  return NextResponse.json({ ok: true, id });
}
