import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { getRun, listStageRuns, MachineError } from "@/db/machines";
import { conversations } from "@/db/schema";
import { NavTrigger } from "@/components/sidebar/nav-drawer";

export const dynamic = "force-dynamic";

/**
 * Read-only view of a historical machine run (0009; the interpreter
 * was deleted by 0037 phase 5 — runs kept as records until purged).
 * The run is a conversation (0012), so rename/move/archive/trash work
 * through the sidebar as for any conversation.
 */
export default async function MachineRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  let run;
  try {
    run = getRun(db(), runId);
  } catch (err) {
    if (err instanceof MachineError && err.code === "not-found") notFound();
    throw err;
  }
  const visits = listStageRuns(db(), runId);
  const conversation = db()
    .select({ title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, runId))
    .get();
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-4 md:py-8">
      <NavTrigger className="-ml-2 mb-2" />
      <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        machine run · retired shape (0037 phase 5) · {run.id}
      </p>
      <h1 className="mt-1 truncate text-lg font-medium">{conversation?.title ?? run.machineName}</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {run.machineName} · {run.status}
        {run.error ? ` — ${run.error}` : ""}
      </p>
      {run.prompt ? (
        <p className="mt-3 whitespace-pre-wrap break-words border-l-2 border-border py-2 pl-3 text-[13px] leading-relaxed text-muted-foreground">
          {run.prompt}
        </p>
      ) : null}
      <ol className="mt-6 space-y-2">
        {visits.map((v) => (
          <li key={v.seq} className="rounded-lg border px-3 py-2 text-[13px]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium">
                {v.seq}. {v.stageId}{" "}
                <span className="font-normal text-muted-foreground">
                  ({v.kind}
                  {v.harness ? ` · ${v.harness}` : ""})
                </span>
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{v.status}</span>
            </div>
            {v.outcome ? (
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-muted-foreground">{v.outcome}</p>
            ) : null}
            {v.sessionId ? (
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">session {v.sessionId}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </main>
  );
}
