import { AppHeader } from "@/components/app-header";
import { PageContextRegistration } from "@/components/page-context";
import { NewPreviewForm } from "@/components/previews/new-preview";
import { PreviewList } from "@/components/previews/preview-list";
import { SetupEditorDialog } from "@/components/previews/setup-editor";
import { db } from "@/db";
import { projectRepos, projects } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * 0016: every preview — servers agents started in chat/run sandboxes,
 * and branch previews (a dedicated sandbox kept current with a branch by
 * the follower). New preview creates the latter. `?id=` highlights one.
 */
export default async function PreviewsPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const withRepos = new Set(db().select({ p: projectRepos.projectId }).from(projectRepos).all().map((r) => r.p));
  const projectOptions = db()
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .all()
    .filter((p) => withRepos.has(p.id));

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-y-auto">
      <PageContextRegistration value={{ kind: "previews" }} />
      <AppHeader crumbs={[{ label: "Previews" }]}>
        <SetupEditorDialog projects={projectOptions} />
        <NewPreviewForm projects={projectOptions} />
      </AppHeader>
      <div className="flex flex-col gap-3 p-6">
        <p className="text-sm text-muted-foreground">
          Dev servers running in sandboxes, at <span className="font-mono text-xs">pv-…</span> URLs on the LAN.
          Agents start them with start_preview; a branch preview follows its branch and redeploys on every push.
        </p>
        <PreviewList
          query=""
          showSandbox
          {...(id ? { highlight: id } : {})}
          empty="No previews yet. Ask an agent in a project chat to start one, or create a branch preview."
        />
      </div>
    </div>
  );
}
