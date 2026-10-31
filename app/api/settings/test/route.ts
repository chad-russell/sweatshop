import { NextResponse } from "next/server";
import { db } from "@/db";
import { testConnector } from "@/lib/settings/connectors";

export const dynamic = "force-dynamic";

/**
 * 0090 §2: the connector [Test] — `{ connector: string }` in, the
 * value-shaped `{ ok, detail }` out. A connector that cannot be tested
 * says so in `detail` (HTTP 200); only a malformed request is a 400.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { connector?: unknown };
  if (typeof body.connector !== "string" || !body.connector.trim()) {
    return NextResponse.json({ error: "connector must be a non-empty string" }, { status: 400 });
  }
  return NextResponse.json(await testConnector(db(), body.connector.trim()));
}
