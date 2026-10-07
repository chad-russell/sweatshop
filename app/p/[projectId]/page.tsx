import { MessageSquarePlus } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { PageContextRegistration } from "@/components/page-context";
import { ProjectSetupEditor } from "@/components/project/project-setup-editor";
import { NewPreviewForm } from "@/components/previews/new-preview";
import { PreviewList } from "@/components/previews/preview-list";
import {
  ProjectDangerZone,
  ProjectImageEditor,
  ProjectNameEditor,
  ProjectReposEditor,
} from "@/components/project/project-editors";
import { ProjectModelsEditor } from "@/components/project/project-models-editor";
import { db } from "@/db";
import { modelsView } from "@/lib/providers/catalog-view";
import { getProjectOverview } from "@/db/projects";
import { resolveCredential } from "@/lib/git-hosts";
import { GIT_HOSTS } from "@/lib/git-hosts/hosts";

export const dynamic = "force-dynamic";

const SECTION = "text-xs font-medium tracking-wide text-muted-foreground uppercase";

/**
 * The project's home (0018/0019): name, repos, sandbox (shared config),
 * the preview setup (its permanent editor), the project's previews,
 * and the danger zone — each concept in one card. Starting a chat
 * lives on / via `?project=`.
 */
export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const overview = getProjectOverview(db(), projectId);
  if (!overview) notFound();
  const { project, repos, credentials, setup } = overview;

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
        <ProjectNameEditor projectId={project.id} name={project.name} />

        <section className="flex flex-col gap-2">
          <h2 className={SECTION}>Repos</h2>
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
          <h2 className={SECTION}>Models</h2>
          <ProjectModelsEditor projectId={project.id} initial={modelsView(db(), project.id)} />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className={SECTION}>Sandbox</h2>
          <ProjectImageEditor projectId={project.id} imageRef={project.imageRef} />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className={SECTION}>Preview setup</h2>
          {/* 0018 phase 2: the definition's permanent editor. */}
          <ProjectSetupEditor
            projectId={project.id}
            repos={repos.map((r) => ({ id: r.id, name: r.name }))}
            initialDefinition={setup.ok ? (setup.setup?.definition ?? null) : null}
            {...(!setup.ok ? { storedIssues: setup.issues } : {})}
          />
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className={SECTION}>Previews</h2>
            {repos.length > 0 && <NewPreviewForm projects={[{ id: project.id, name: project.name }]} />}
          </div>
          <PreviewList
            query={`project=${encodeURIComponent(project.id)}`}
            showSandbox
            empty="No previews yet — create a branch preview, or ask an agent in a project chat."
          />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className={SECTION}>Danger zone</h2>
          <ProjectDangerZone projectId={project.id} name={project.name} />
        </section>
      </div>
    </div>
  );
}
