import { NextResponse } from "next/server";
import { db } from "@/db";
import { getRun, getStageRun, visitToken } from "@/db/machines";
import { END } from "@/lib/machines/definition";
import { eveStageHook, gateHook } from "@/workflows/machines/run-machine";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ runId: string; seq: string }> };

/**
 * Resume a waiting stage visit (0009): `{ to, comment?|reason? }`.
 * Human gates are answered from /inbox and the run view; eve stages are
 * resumed by their `transition` tool (the eve runtime is a separate
 * process, so it reaches the workflow through this route). `to` must be
 * one of the stage's targets — the interpreter re-checks it anyway.
 */
export async function POST(request: Request, { params }: Ctx) {
  const { runId, seq: seqText } = await params;
  const seq = Number(seqText);
  let body: { to?: unknown; comment?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "expected a JSON body" }, { status: 400 });
  }
  let run;
  try {
    run = getRun(db(), runId);
  } catch {
    return NextResponse.json({ error: `run ${runId} not found` }, { status: 404 });
  }
  const visit = Number.isInteger(seq) ? getStageRun(db(), runId, seq) : null;
  if (!visit) return NextResponse.json({ error: "visit not found" }, { status: 404 });
  const stage = run.definition.stages[visit.stageId];
  const targets = stage?.next.map((t) => t.to) ?? [];
  const to = typeof body.to === "string" ? body.to : null;
  // Single/zero-target stages accept a bare "done" (to = null).
  if (targets.length > 1 && (!to || !targets.includes(to))) {
    return NextResponse.json({ error: `to must be one of: ${targets.join(", ")}` }, { status: 400 });
  }
  if (visit.status !== "waiting" && visit.status !== "running") {
    return NextResponse.json({ error: `visit is ${visit.status}` }, { status: 409 });
  }
  const token = visitToken(runId, seq);
  const resolved = targets.length > 1 ? to! : (targets[0] ?? END);
  try {
    if (visit.kind === "human") {
      const comment = typeof body.comment === "string" && body.comment.trim() ? body.comment.trim() : undefined;
      await gateHook.resume(token, { to: resolved, ...(comment ? { comment } : {}) });
    } else if (visit.kind === "eve") {
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 2000) : undefined;
      await eveStageHook.resume(token, { to: resolved, ...(reason ? { reason } : {}) });
    } else {
      return NextResponse.json({ error: "harness stages transition on their own" }, { status: 409 });
    }
    return NextResponse.json({ ok: true, to: resolved });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "resume failed" },
      { status: 409 },
    );
  }
}
