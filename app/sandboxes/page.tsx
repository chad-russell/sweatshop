import Link from "next/link";
import { Box } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { LocalTime } from "@/components/local-time";
import { RunCleanupButton } from "@/components/sandbox-actions";
import { SandboxStatus } from "@/components/sandbox-status";
import { db } from "@/db";
import { listSandboxSummaries } from "@/db/sandbox-view";
import { shortSandboxId } from "@/lib/sandbox-id";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Sandboxes (0011): every sandbox, who owns it, and what has used it. */
export default function SandboxesPage() {
  const sandboxes = listSandboxSummaries(db());
  const live = sandboxes.filter((s) => s.status !== "destroyed");
  const gone = sandboxes.filter((s) => s.status === "destroyed");

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-y-auto">
      <AppHeader crumbs={[{ label: "Sandboxes" }]}>
        <span className="font-mono text-xs text-muted-foreground">
          {live.length} live{gone.length > 0 ? ` · ${gone.length} destroyed` : ""}
        </span>
        <RunCleanupButton />
      </AppHeader>
      <div className="flex flex-col gap-8 p-6">
        {sandboxes.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No sandboxes yet. One is created the first time a project chat runs a sandboxed tool.
          </p>
        )}
        <SandboxList title="Live" sandboxes={live} />
        <SandboxList title="Destroyed" sandboxes={gone} />
      </div>
    </div>
  );
}

function SandboxList({
  title,
  sandboxes,
}: {
  title: string;
  sandboxes: ReturnType<typeof listSandboxSummaries>;
}) {
  if (sandboxes.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {sandboxes.map((s) => (
          <li key={s.id}>
            <Link
              href={`/sandboxes/${s.id}`}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent",
                s.status === "destroyed" && "opacity-60",
              )}
            >
              <Box className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="w-16 shrink-0 font-mono text-xs">{shortSandboxId(s.id)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.ownerLabel}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {s.ownerKind === "machine_run" ? "machine run" : "chat"}
                  {s.projectName ? ` · ${s.projectName}` : ""}
                  {" · "}
                  {s.calls} call{s.calls === 1 ? "" : "s"} · {s.chats} chat{s.chats === 1 ? "" : "s"}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-0.5">
                <SandboxStatus status={s.status} />
                <LocalTime
                  ms={s.destroyedAt ?? s.lastUsedAt}
                  className="font-mono text-[10px] text-muted-foreground"
                />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
