import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { PageContextRegistration } from "@/components/page-context";
import { NewPreviewForm } from "@/components/previews/new-preview";
import { PreviewList } from "@/components/previews/preview-list";
import { db } from "@/db";
import { listProjectsWithRepos } from "@/db/projects";

export const dynamic = "force-dynamic";

/**
 * 0016: every preview — servers agents started in chat/run sandboxes,
 * and branch previews (a dedicated sandbox kept current with a branch by
 * the follower). New preview creates the latter. `?id=` highlights one.
 */
export default async function PreviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; project?: string }>;
}) {
  const { id, project } = await searchParams;
  const projectOptions = listProjectsWithRepos(db());
  const scoped = project ? (projectOptions.find((p) => p.id === project) ?? null) : null;

  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col overflow-y-auto">
      <PageContextRegistration value={{ kind: "previews" }} />
      <AppHeader
        crumbs={[{ label: "Previews" }, ...(scoped ? [{ label: scoped.name }] : [])]}
      >
        <NewPreviewForm projects={projectOptions} />
      </AppHeader>
      <div className="flex flex-col gap-3 p-4 md:p-6">
        <p className="text-sm text-muted-foreground">
          {scoped ? (
            <>
              Previews for <span className="font-medium text-foreground">{scoped.name}</span>.{" "}
              <Link href="/previews" className="underline-offset-2 hover:underline">
                All previews →
              </Link>
            </>
          ) : (
            <>
              Dev servers running in sandboxes, at <span className="font-mono text-xs">pv-…</span> URLs on the LAN.
              Agents start them with start_preview; a branch preview follows its branch and redeploys on every push.
            </>
          )}
        </p>
        <PreviewList
          query={scoped ? `project=${encodeURIComponent(scoped.id)}` : ""}
          showSandbox
          {...(id ? { highlight: id } : {})}
          empty={
            scoped
              ? `No previews for ${scoped.name} yet — create a branch preview, or ask an agent in a project chat.`
              : "No previews yet. Ask an agent in a project chat to start one, or create a branch preview."
          }
        />
      </div>
    </div>
  );
}
