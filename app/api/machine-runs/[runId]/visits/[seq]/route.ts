import { NextResponse } from "next/server";
import { db } from "@/db";
import { getRun, getStageRun, visitToken } from "@/db/machines";
import { END } from "@/lib/machines/definition";
import { gateHook } from "@/workflows/machines/run-machine";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ runId: string; seq: string }> };

/**
 * Resume a waiting human-gate visit (0009): `{ to, comment? }`, answered
 * from /inbox and the run view. (0010 Phase 5: agent stages run
 * in-process and advance on their own — only human gates wait.) `to`
 * must be one of the stage's targets — the interpreter re-checks it.
 */
export async function POST(request: Request, { params }: Ctx) {
  const { runId, seq: seqText } = await params;
  const seq = Number(seqText);
  let body: { to?: unknown; comment?: unknown; reason?: unknown; auto?: unknown };
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
  // Single/zero-target stages need no `to`.
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
    } else {
      return NextResponse.json({ error: "this stage kind transitions on its own" }, { status: 409 });
    }
    return NextResponse.json({ ok: true, to: resolved });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "resume failed" },
      { status: 409 },
    );
  }
}
