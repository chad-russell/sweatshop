import { NextResponse } from "next/server";
import { db } from "@/db";
import { gitCredentials } from "@/db/schema";
import { prStateFor } from "@/lib/prs/state";

export const dynamic = "force-dynamic";

/** 0052: the phase chip asks about one PR, a transcript about a few —
 *  past this the request is someone else's problem. */
const MAX_URLS = 10;

/** Live PR lifecycle states (0052), batched: `?url=<PR web url>`
 *  repeatable, answered as `{ [url]: { state, mergedAt? } | null }`
 *  keyed by the exact input URL. An unresolvable URL maps to null.
 *  0084: the resolution lives in lib/prs/state.ts — a settled watch
 *  row answers from the row, everything else is asked live. */
export async function GET(request: Request) {
  const urls = new URL(request.url).searchParams.getAll("url").slice(0, MAX_URLS);
  if (urls.length === 0) return NextResponse.json({});
  const credentials = db().select().from(gitCredentials).all();
  const entries = await Promise.all(
    urls.map(async (url) => [url, await prStateFor(url, credentials)] as const),
  );
  return NextResponse.json(Object.fromEntries(entries));
}
