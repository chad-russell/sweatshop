import { NextResponse } from "next/server";
import { db } from "@/db";
import { markAllSeen } from "@/db/attention";

export const dynamic = "force-dynamic";

/** 0008: mark every live conversation seen ("mark all read"). */
export async function POST() {
  markAllSeen(db());
  return NextResponse.json({ ok: true });
}
