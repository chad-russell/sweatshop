import { NextResponse } from "next/server";
import { reap } from "@/lib/sandboxes/reaper";

export const dynamic = "force-dynamic";

/**
 * 0013: run the sandbox reaper now — "Run cleanup now" on /sandboxes and
 * `npm run sandbox:gc`. `?dry=1` reports without acting.
 */
export async function POST(request: Request) {
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  return NextResponse.json(await reap({ apply: !dry }));
}
