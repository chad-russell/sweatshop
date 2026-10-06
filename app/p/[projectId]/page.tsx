import { MessageSquarePlus } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { PageContextRegistration } from "@/components/page-context";
import { ProjectSetupEditor } from "@/components/project/project-setup-editor";
import {
  ProjectDangerZone,
  ProjectOverviewEditor,
  ProjectReposEditor,
} from "@/components/project/project-editors";
import { db } from "@/db";
import { getProjectOverview } from "@/db/projects";
import { resolveCredential } from "@/lib/git-hosts";
import { GIT_HOSTS } from "@/lib/git-hosts/hosts";

export const dynamic = "force-dynamic";

/**
 * The project's home (0018): its properties and config, editable (phase
 * 3) — name + sandbox config, repos, the preview setup — plus links to
 * its work surfaces and the danger zone. Starting a chat lives on /
 * via `?project=`.
 */
export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const overview = getProjectOverview(db(), projectId);
  if (!overview) notFound();
  const { project, repos, credentials, configOptions, config, sharedWith, setup } = overview;

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
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Overview</h2>
          <p className="font-mono text-xs text-muted-foreground">{project.id}</p>
          <ProjectOverviewEditor
            projectId={project.id}
            name={project.name}
            config={config ? { id: config.id, imageRef: config.imageRef, networkPolicy: config.networkPolicy } : null}
            configOptions={configOptions.map((c) => ({ id: c.id }))}
            sharedWith={sharedWith}
          />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Repos</h2>
          <ProjectReposEditor
            projectId={project.id}
            repos={repos.map((repo) => ({
              id: repo.id,
              name: repo.name,
              url: repo.url,
              host: resolveCredential(repo.url, credentials, GIT_HOSTS)?.host.kind ?? null,
            }))}
          />
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

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Danger zone</h2>
          <ProjectDangerZone projectId={project.id} name={project.name} />
        </section>
      </div>
    </div>
  );
}
