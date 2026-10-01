import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { listMachines, listRuns } from "@/db/machines";

export const dynamic = "force-dynamic";

/** Machines (0009): the catalog, plus the latest runs across all of them. */
export default function MachinesPage() {
  const machines = listMachines(db());
  const runs = listRuns(db(), { limit: 15 });
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Machines</h1>
        <Button asChild size="sm">
          <Link href="/machines/new">
            <Plus /> New machine
          </Link>
        </Button>
      </header>

      <ul className="flex flex-col gap-2">
        {machines.map((m) => {
          const stages = Object.values(m.definition.stages);
          return (
            <li key={m.id}>
              <Link
                href={`/machines/${m.id}`}
                className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4 text-card-foreground transition-colors hover:bg-accent"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{m.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {m.id} · v{m.version} · {m.definition.workspace === "project" ? "project" : "no workspace"}
                  </span>
                </span>
                {m.description && <span className="text-sm text-muted-foreground">{m.description}</span>}
                <span className="font-mono text-xs text-muted-foreground">
                  {stages.map((s) => (s.kind === "harness" ? `${s.title}:${s.harness}` : `${s.title}:${s.kind}`)).join(" → ")}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Recent runs</h2>
        {runs.length === 0 && <p className="text-sm text-muted-foreground">No runs yet.</p>}
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {runs.map((r) => (
            <li key={r.id}>
              <Link href={`/r/${r.id}`} className="flex items-baseline gap-3 px-3 py-2 text-sm hover:bg-accent">
                <span className="w-36 shrink-0 font-mono text-xs text-muted-foreground">{r.status}</span>
                <span className="shrink-0 font-medium">{r.machineName}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.prompt}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
