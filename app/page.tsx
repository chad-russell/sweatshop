import { ChatSurface } from "@/components/chat";
import { db } from "@/db";
import { projects } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * Chats home (0018: THE new-conversation page): a fresh chat — plain,
 * scoped to a project via `?project=` (the composer's target picker
 * picks it too), or running a skill via `?skill=` (0039; project
 * scope only). The key remounts on scope change so a different composer
 * mode starts clean.
 *
 * 0055: `?mode=ticket` enters ticket mode on the first send — the same
 * server-side path as picking "ticket" from the skill picker or the
 * legacy `?skill=ticket` (the send route treats `skill: "ticket"` as a
 * mode-entry request, not a plain bind), so reusing the skill-id prop
 * is enough; no separate client plumbing needed.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; skill?: string; mode?: string }>;
}) {
  const { project, skill, mode } = await searchParams;
  const skillId = mode === "ticket" ? "ticket" : (skill ?? null);
  const projectOptions = db().select({ id: projects.id, name: projects.name }).from(projects).all();
  const scoped = project ? (projectOptions.find((p) => p.id === project) ?? null) : null;

  return (
    <ChatSurface
      key={`${scoped?.id ?? "chat"}:${skillId ?? ""}`}
      initialSkillId={skillId}
      projectOptions={projectOptions}
      {...(scoped ? { projectId: scoped.id, projectName: scoped.name } : {})}
    />
  );
}
