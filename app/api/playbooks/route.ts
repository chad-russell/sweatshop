import { NextResponse } from "next/server";
import { listPlaybooks } from "@/lib/playbooks";

export const dynamic = "force-dynamic";

/** 0037: the playbook catalog for the composer's picker. */
export async function GET() {
  const playbooks = (await listPlaybooks()).map(({ id, title, description }) => ({ id, title, description }));
  return NextResponse.json({ playbooks });
}
