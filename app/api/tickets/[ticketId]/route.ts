import { eq } from "drizzle-orm";
import { db } from "@/db";
import { ticketRuns } from "@/db/schema";

export const dynamic = "force-dynamic";

/** Ticket run status — the UI polls this. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  const { ticketId } = await params;
  const row = db()
    .query.ticketRuns.findFirst({ where: eq(ticketRuns.id, ticketId) })
    .sync();
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ run: row });
}
