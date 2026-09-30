import { planApprovalHook } from "@/workflows/run-ticket";

export const dynamic = "force-dynamic";

/** Answer a pending plan approval (token = ticketId). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  const { ticketId } = await params;
  const body = (await request.json()) as { approved?: boolean; comment?: string };
  if (typeof body.approved !== "boolean") {
    return Response.json(
      { error: "approved (boolean) is required" },
      { status: 400 },
    );
  }
  try {
    await planApprovalHook.resume(ticketId, {
      approved: body.approved,
      comment: body.comment,
    });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "resume failed" },
      { status: 409 },
    );
  }
}
