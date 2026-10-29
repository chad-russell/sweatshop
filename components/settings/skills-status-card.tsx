import { status } from "@/lib/skills/store";

/** 0088: read-only store status — skills are built and edited by the agent (save_skill), not here. */
export async function SkillsStatusCard() {
  const s = await status();
  return (
    <section aria-labelledby="skills-status-title" className="mt-10 space-y-3 border-t border-border pt-6">
      <h2 id="skills-status-title" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Skills</h2>
      <div className="space-y-1 rounded-lg border border-border p-4 text-sm">
        {s.configured ? (
          <p>
            Connected to the skills store · {s.skillCount ?? 0} {s.skillCount === 1 ? "skill" : "skills"}
          </p>
        ) : (
          <p className="text-muted-foreground">
            Not configured — set the <code>SKILLS_S3_*</code> environment variables to enable a skills catalog.
          </p>
        )}
        {s.lastError && <p role="alert" className="text-destructive">Last error: {s.lastError}</p>}
        <p className="text-xs text-muted-foreground">
          Skills live in S3-compatible storage. Ask the agent to create or edit one; you approve every save.
        </p>
      </div>
    </section>
  );
}
