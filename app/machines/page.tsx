import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { listMachines } from "@/db/machines";

export const dynamic = "force-dynamic";

/** Machines (0009): the catalog. Runs live in the sidebar beside chats (0012). */
export default function MachinesPage() {
  const machines = listMachines(db());
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
    </div>
  );
}
