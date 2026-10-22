import { NextResponse } from "next/server";
import { listThreadSkills } from "@/lib/skills";

export const dynamic = "force-dynamic";

/** 0039: the thread-skill catalog for the composer's picker. */
export async function GET() {
  const skills = (await listThreadSkills()).map(({ id, title, description }) => ({ id, title, description }));
  return NextResponse.json({ skills });
}
