import { AppHeader } from "@/components/app-header";
import { PageContextRegistration } from "@/components/page-context";
import { SkillsCatalog } from "@/components/settings/skills-catalog";
import { listAllSkills, status } from "@/lib/skills/store";

export const dynamic = "force-dynamic";

/**
 * 0090 §4: the skills catalog. The store's health sits on top (the ONE
 * empty state this page can't hide); the list below includes disabled
 * skills — the client island filters, the detail route acts.
 */
export default async function SettingsSkillsPage() {
  const [skills, health] = await Promise.all([listAllSkills(), status()]);
  const total = skills.length;
  const active = health.configured ? (health.skillCount ?? 0) : 0;
  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col overflow-y-auto">
      <PageContextRegistration value={{ kind: "other" }} />
      <AppHeader crumbs={[{ label: "Settings", href: "/settings" }, { label: "Skills" }]} />
      <div className="flex flex-col gap-6 p-4 md:p-6">
        <section aria-labelledby="skills-health-title" className="flex flex-col gap-2">
          <h2 id="skills-health-title" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Store
          </h2>
          <div className="space-y-1 rounded-lg border border-border p-4 text-sm">
            {health.configured ? (
              <p>
                Connected to the skills store ·{" "}
                {total === active ? `${total} skill${total === 1 ? "" : "s"}` : `${active} of ${total} active`}
              </p>
            ) : (
              <p className="text-muted-foreground">
                Not configured — set the <code>SKILLS_S3_*</code> environment variables to enable a skills catalog.
              </p>
            )}
            {health.lastError && (
              <p role="alert" className="text-destructive">
                Last error: {health.lastError}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Skills live in S3-compatible storage. Ask the agent to create or edit one; you approve every save.
            </p>
          </div>
        </section>
        <SkillsCatalog skills={skills} />
      </div>
    </div>
  );
}
