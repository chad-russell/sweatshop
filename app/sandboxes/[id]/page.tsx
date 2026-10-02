import Link from "next/link";
import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { LocalTime } from "@/components/local-time";
import { SandboxActions } from "@/components/sandbox-actions";
import { SandboxStatus } from "@/components/sandbox-status";
import { shortSandboxId } from "@/lib/sandbox-id";
import { db } from "@/db";
import { getSandboxDetail } from "@/db/sandbox-view";
import { boundToSandbox } from "@/lib/sandboxes/reaper";

export const dynamic = "force-dynamic";

/** One sandbox (0011): owner, who is using it, and the calls that ran in it. */
export default async function SandboxPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sandbox = getSandboxDetail(db(), id);
  if (!sandbox) notFound();

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-y-auto">
      <AppHeader
        crumbs={[
          { label: "Sandboxes", href: "/sandboxes" },
          { label: shortSandboxId(sandbox.id), mono: true },
        ]}
      >
        <SandboxStatus status={sandbox.status} />
        <SandboxActions sandboxId={sandbox.id} status={sandbox.status} bound={boundToSandbox(sandbox.id)} />
      </AppHeader>

      <div className="flex flex-col gap-8 p-6">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Owner</dt>
          <dd className="min-w-0">
            <Link href={sandbox.ownerHref} className="font-medium underline-offset-2 hover:underline">
              {sandbox.ownerLabel}
            </Link>
            <span className="text-muted-foreground">
              {" "}
              · {sandbox.ownerKind === "machine_run" ? "machine run" : "chat"}
            </span>
          </dd>
          {sandbox.projectName && (
            <>
              <dt className="text-muted-foreground">Project</dt>
              <dd>
                <Link
                  href={`/p/${sandbox.projectId}`}
                  className="underline-offset-2 hover:underline"
                >
                  {sandbox.projectName}
                </Link>
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Id</dt>
          <dd className="font-mono text-xs break-all">{sandbox.id}</dd>
          <dt className="text-muted-foreground">Provider</dt>
          <dd className="font-mono text-xs break-all">
            {sandbox.provider}
            {sandbox.ref ? ` · ${sandbox.ref}` : ""}
          </dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>
            <LocalTime ms={sandbox.createdAt} />
          </dd>
          <dt className="text-muted-foreground">
            {sandbox.destroyedAt ? "Destroyed" : "Last used"}
          </dt>
          <dd>
            <LocalTime ms={sandbox.destroyedAt ?? sandbox.lastUsedAt} />
          </dd>
        </dl>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Chats using it ({sandbox.users.length})
          </h2>
          {sandbox.users.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {sandbox.ownerKind === "machine_run"
                ? "No chats have run calls here. A machine run's stages run inside it directly."
                : "No recorded calls yet."}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {sandbox.users.map((u) => (
                <li key={u.conversationId}>
                  <Link
                    href={`/c/${u.conversationId}`}
                    className="flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-accent"
                  >
                    <span className="min-w-0 flex-1 truncate">{u.title ?? u.conversationId}</span>
                    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {u.owner ? "owner" : "attached"}
                    </span>
                    <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground">
                      {u.calls} call{u.calls === 1 ? "" : "s"}
                    </span>
                    {u.lastAt && (
                      <LocalTime
                        ms={u.lastAt}
                        className="w-16 shrink-0 text-right font-mono text-[10px] text-muted-foreground"
                      />
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Recent calls
          </h2>
          {sandbox.recentCalls.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing recorded. Calls made before sandbox tracking shipped are not attributed.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {sandbox.recentCalls.map((c) => (
                <li key={c.toolCallId}>
                  <Link
                    href={`/c/${c.conversationId}`}
                    className="flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-accent"
                  >
                    <span className="w-14 shrink-0 font-mono text-xs">{c.tool}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {c.conversationTitle ?? c.conversationId}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {c.via === "attached" ? "attached" : "own"}
                    </span>
                    <LocalTime
                      ms={c.at}
                      className="w-16 shrink-0 text-right font-mono text-[10px] text-muted-foreground"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
