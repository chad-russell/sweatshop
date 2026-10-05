import { MessageSquarePlus } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { PageContextRegistration } from "@/components/page-context";
import { ProjectSetupEditor } from "@/components/previews/project-setup-editor";
import { db } from "@/db";
import { getPreviewSetup } from "@/db/preview-setups";
import { gitCredentials, projectRepos, projects, sandboxConfigs } from "@/db/schema";
import { resolveCredential } from "@/lib/git-hosts";
import { GIT_HOSTS } from "@/lib/git-hosts/hosts";

export const dynamic = "force-dynamic";

/**
 * The project's home (0018 phase 1): its properties and config — repos
 * and their resolved git hosts, the sandbox config — plus links to its
 * work surfaces. Starting a chat moved to / (via `?project=`); editing
 * these properties arrives with phase 3 (db-first until then).
 */
export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const project = db().query.projects.findFirst({ where: eq(projects.id, projectId) }).sync();
  if (!project) notFound();

  const repos = db().select().from(projectRepos).where(eq(projectRepos.projectId, project.id)).all();
  const credentials = db().select().from(gitCredentials).all();
  const config = project.sandboxConfigId
    ? db().query.sandboxConfigs.findFirst({ where: eq(sandboxConfigs.id, project.sandboxConfigId) }).sync()
    : null;
  const setup = getPreviewSetup(db(), project.id);

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-y-auto">
      {/* 0015: the panel's "this" on a project page. */}
      <PageContextRegistration value={{ kind: "project", id: project.id, title: project.name, projectId: project.id }} />
      <AppHeader crumbs={[{ label: project.name }]}>
        <Button asChild size="sm">
          <Link href={`/?project=${encodeURIComponent(project.id)}`}>
            <MessageSquarePlus /> New chat
          </Link>
        </Button>
      </AppHeader>

      <div className="flex flex-col gap-8 p-6">
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Overview</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="font-medium">{project.name}</dd>
            <dt className="text-muted-foreground">Id</dt>
            <dd className="font-mono text-xs break-all">{project.id}</dd>
            <dt className="text-muted-foreground">Sandbox config</dt>
            <dd className="font-mono text-xs break-all">
              {config ? `${config.id} · image ${config.imageRef ?? "default"} · network ${config.networkPolicy}` : "none (default image, sandbox per chat)"}
            </dd>
          </dl>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Repos</h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {repos.map((repo) => {
              const resolved = resolveCredential(repo.url, credentials, GIT_HOSTS);
              return (
                <li key={repo.id} className="flex flex-col gap-1 px-3 py-2 text-sm">
                  <span className="font-medium">{repo.name}</span>
                  <span className="flex flex-wrap items-center gap-x-2 font-mono text-xs text-muted-foreground">
                    <span className="min-w-0 break-all">{repo.url}</span>
                    <span aria-hidden>·</span>
                    <span>{resolved ? `${resolved.host.kind} credential` : "no credential"}</span>
                  </span>
                </li>
              );
            })}
            {repos.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">
                No repos — chats in this project run sandbox-less until one is added (db:seed today, phase 3 UI soon).
              </li>
            )}
          </ul>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Preview setup</h2>
          {/* 0018 phase 2: the definition's permanent editor. */}
          <ProjectSetupEditor
            projectId={project.id}
            repos={repos.map((r) => ({ id: r.id, name: r.name }))}
            initialDefinition={setup.ok ? (setup.setup?.definition ?? null) : null}
            {...(!setup.ok ? { storedIssues: setup.issues } : {})}
          />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Work surfaces</h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border text-sm">
            <li>
              <Link href="/machines" className="flex items-center justify-between px-3 py-2 transition-colors hover:bg-accent">
                <span>Machines</span>
                <span className="text-xs text-muted-foreground">the automation catalog →</span>
              </Link>
            </li>
            <li>
              <Link
                href={`/previews?project=${encodeURIComponent(project.id)}`}
                className="flex items-center justify-between px-3 py-2 transition-colors hover:bg-accent"
              >
                <span>Previews</span>
                <span className="text-xs text-muted-foreground">branch + chat previews →</span>
              </Link>
            </li>
          </ul>
        </section>

        <p className="text-xs text-muted-foreground">
          Properties are db-first for now (<span className="font-mono">npm run db:seed</span>); project editing arrives
          with 0018 phase 3.
        </p>
      </div>
    </div>
  );
}
