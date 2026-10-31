import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { LocalTime } from "@/components/local-time";
import { PageContextRegistration } from "@/components/page-context";
import { MessageResponse } from "@/components/ai-elements/message";
import { SkillActions } from "@/components/settings/skill-actions";
import { LABEL, MONO } from "@/components/form-styles";
import { readSkill } from "@/lib/skills/store";

export const dynamic = "force-dynamic";

/**
 * 0090 §4: one skill — the rendered body (the SAME streamdown
 * composition as chat, via MessageResponse), supporting files as
 * inline viewers, and the §5 lifecycle actions. The body is data, never
 * executed; a disabled skill reads here exactly as the agent left it.
 */
export default async function SkillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const skill = await readSkill(decodeURIComponent(id));
  if (!skill) notFound();
  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col overflow-y-auto">
      <PageContextRegistration value={{ kind: "other" }} />
      <AppHeader
        crumbs={[{ label: "Settings", href: "/settings" }, { label: "Skills", href: "/settings/skills" }, { label: skill.id }]}
      />
      <div className="flex flex-col gap-6 p-4 md:p-6">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className={`${MONO} text-base font-medium`}>{skill.id}</h1>
            {skill.disabled && (
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                disabled
              </span>
            )}
            <span className={LABEL}>
              updated <LocalTime className={LABEL} ms={Date.parse(skill.updatedAt)} />
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{skill.description}</p>
          {skill.source && (
            <p className={`${MONO} text-xs text-muted-foreground`}>
              from {skill.source.repo} · {skill.source.path} · pinned {skill.source.ref.slice(0, 7)}
            </p>
          )}
        </header>
        <MessageResponse className="text-sm">{skill.body}</MessageResponse>
        {skill.files.length > 0 && (
          <section aria-labelledby="skill-files-title" className="flex flex-col gap-2">
            <h2 id="skill-files-title" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Files
            </h2>
            <ul className="flex flex-col gap-2">
              {skill.fileContents.map((file) => (
                <li key={file.path} className="rounded-lg border border-border">
                  <details>
                    <summary className={`${MONO} cursor-pointer px-3 py-2 text-xs`}>{file.path}</summary>
                    <pre className="overflow-x-auto border-t border-border px-3 py-2 font-mono text-xs whitespace-pre-wrap">
                      {file.content}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          </section>
        )}
        <SkillActions id={skill.id} disabled={skill.disabled} />
      </div>
    </div>
  );
}
