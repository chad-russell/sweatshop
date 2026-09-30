import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { ticketRuns } from "@/db/schema";
import { TicketRunView } from "@/components/ticket-run-view";

export const dynamic = "force-dynamic";

/** Live view of one ticket run (0004 Path B). */
export default async function TicketRunPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { ticketId } = await params;
  const run = db()
    .query.ticketRuns.findFirst({ where: eq(ticketRuns.id, ticketId) })
    .sync();
  if (!run) notFound();

  return (
    <TicketRunView
      initial={{
        id: run.id,
        projectId: run.projectId,
        ticket: run.ticket,
        status: run.status,
        detail: run.detail,
        branch: run.branch,
        prUrl: run.prUrl,
      }}
    />
  );
}
