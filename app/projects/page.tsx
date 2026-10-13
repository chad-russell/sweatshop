import { FolderGit2 } from "lucide-react";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { NewProjectButton } from "@/components/project/new-project";
import { db } from "@/db";
import { loadAttention } from "@/db/attention";
import { listProjectCards } from "@/db/projects";

export const dynamic = "force-dynamic";

/**
 * 0040: the Projects index — a card per project linking to its page
 * (`/p/<id>`), plus New project (the dialog itself mounts in the layout
 * and opens by NEW_PROJECT_EVENT, so ⌘K reaches it from anywhere).
 */
export default async function ProjectsPage() {
  const cards = listProjectCards(db(), loadAttention(db()).needsYou);

  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col overflow-y-auto">
      <AppHeader crumbs={[{ label: "Projects" }]}>
        <NewProjectButton />
      </AppHeader>
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <p className="text-sm text-muted-foreground">
          A project is one or more git repos plus the sandbox, models and defaults every chat in it
          shares.
        </p>
        {cards.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No projects yet — create one to give chats a repo to work in.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {cards.map((card) => (
              <li key={card.id}>
                <Link
                  href={`/p/${encodeURIComponent(card.id)}`}
                  className="flex h-full flex-col gap-2 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="flex items-center gap-2 font-medium">
                    <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{card.name}</span>
                  </span>
                  {card.name !== card.id && (
                    <span className="truncate font-mono text-xs text-muted-foreground">{card.id}</span>
                  )}
                  <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 font-mono text-xs text-muted-foreground">
                    <span>
                      {card.repoCount} {card.repoCount === 1 ? "repo" : "repos"}
                    </span>
                    <span>
                      {card.chatCount} {card.chatCount === 1 ? "chat" : "chats"}
                    </span>
                    {card.needsYou > 0 && (
                      <span className="text-warning">● {card.needsYou} needs you</span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
