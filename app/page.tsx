import { ChatSurface } from "@/components/chat";
import { db } from "@/db";
import { projects } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * Chats home (0018: THE new-conversation page): a fresh chat — plain,
 * scoped to a project via `?project=` (the composer's target picker
 * picks it too). The key remounts on scope change.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  const projectOptions = db().select({ id: projects.id, name: projects.name }).from(projects).all();
  const scoped = project ? (projectOptions.find((p) => p.id === project) ?? null) : null;

  return (
    <ChatSurface
      key={scoped?.id ?? "chat"}
      projectOptions={projectOptions}
      {...(scoped ? { projectId: scoped.id, projectName: scoped.name } : {})}
    />
  );
}
