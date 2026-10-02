import { NextResponse } from "next/server";
import { db } from "@/db";
import { listSandboxSummaries } from "@/db/sandbox-view";

export const dynamic = "force-dynamic";

/**
 * 0010/0011: sandboxes a chat can attach to, for the composer's picker —
 * the explicit "join another owner's sandbox" escape hatch (docs/0010).
 * Running and idle-stopped ones qualify (attach resumes a stopped
 * sandbox); creating and destroyed ones do not. Labelled for humans
 * (owner title, project, last use) with the same summaries /sandboxes
 * shows.
 */
export async function GET() {
  const attachable = listSandboxSummaries(db()).filter(
    (s) => s.status === "running" || s.status === "stopped",
  );
  return NextResponse.json({
    sandboxes: attachable.map((s) => ({
      id: s.id,
      status: s.status,
      ownerKind: s.ownerKind,
      ownerId: s.ownerId,
      ownerLabel: s.ownerLabel,
      projectId: s.projectId,
      projectName: s.projectName,
      lastUsedAt: s.lastUsedAt,
      calls: s.calls,
      ref: s.ref,
    })),
  });
}
