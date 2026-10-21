import { NextResponse } from "next/server";
import { listThreadSkills } from "@/lib/skills";

export const dynamic = "force-dynamic";

/** 0039: the thread-skill catalog for the composer's picker. 0055 v7:
 *  `mode` rides along so the picker can distinguish modes from plain
 *  thread skills (PR 2's UI; no visual change yet). */
export async function GET() {
  const skills = (await listThreadSkills()).map(({ id, title, description, mode }) => ({ id, title, description, mode }));
  return NextResponse.json({ skills });
}
