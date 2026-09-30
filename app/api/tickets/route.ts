import { db } from "@/db";
import { ticketRuns } from "@/db/schema";
import { runTicketWorkflow } from "@/workflows/run-ticket";
import { start } from "workflow/api";

export const dynamic = "force-dynamic";

/** Trigger a ticket run (0004 Path B) — direct, no agent session. */
export async function POST(request: Request) {
  const body = (await request.json()) as { projectId?: string; ticket?: string };
  const projectId = body.projectId?.trim();
  const ticket = body.ticket?.trim();
  if (!projectId || !ticket) {
    return Response.json(
      { error: "projectId and ticket are required" },
      { status: 400 },
    );
  }

  const ticketId = `tr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  db()
    .insert(ticketRuns)
    .values({
      id: ticketId,
      projectId,
      ticket,
      status: "starting",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();

  await start(runTicketWorkflow, [{ ticketId, projectId, ticket }]);
  return Response.json({ ticketId });
}
