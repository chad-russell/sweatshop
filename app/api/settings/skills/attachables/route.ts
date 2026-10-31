import { NextResponse } from "next/server";
import { listAllSkills } from "@/lib/skills/store";

export const dynamic = "force-dynamic";

/** 0091 §3: the composer picker's list — every skill that is not
 *  disabled. Manual- and tool-mode skills come FIRST (they can only
 *  join a chat by attach), then auto ones (attach = one-turn override);
 *  ids ascend within each group. Value-shaped: a down or unconfigured
 *  store is an empty list, never an error for the picker. */
export async function GET() {
  const rows = await listAllSkills();
  const rank = (invoke?: string) => (invoke === "manual" ? 0 : invoke === "tool" ? 1 : 2);
  const skills = rows
    .filter((skill) => !skill.disabled)
    .sort((a, b) => rank(a.invoke) - rank(b.invoke) || a.id.localeCompare(b.id))
    .map(({ id, description, invoke }) => ({ id, description, invoke: invoke ?? "auto" }));
  return NextResponse.json({ ok: true, skills });
}
