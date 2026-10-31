import type { HarnessAgentSkill } from "@ai-sdk/harness/agent";
import { renderOwnerPlaceholders } from "./agent/owner";
import { listSkills, readSkill } from "./skills/store";

/**
 * 0088: the skills catalog as the harness adapters' native skill shape —
 * pi/codex materialize it at `~/.agents/skills`, claude at
 * `~/.claude/skills`. Loaded fresh per call so a saved edit reaches the
 * next call; value-shaped on store errors (an empty array, logged) so a
 * dead store never blocks a harness call start. 0091 §2: manual skills
 * never mount (listSkills already drops them; the re-read guard keeps
 * it true even if a listing races a mode flip).
 */

export type HarnessSkills = readonly HarnessAgentSkill[];

export async function loadHarnessSkills(): Promise<HarnessSkills> {
  try {
    const listed = await listSkills();
    const skills = await Promise.all(listed.map((entry) => readSkill(entry.id)));
    return skills.flatMap((skill) =>
      skill && !skill.disabled && skill.invoke !== "manual"
        ? [
            {
              name: skill.id,
              description: renderOwnerPlaceholders(skill.description),
              content: renderOwnerPlaceholders(skill.body),
              files: skill.fileContents.map(({ path, content }) => ({ path, content })),
            },
          ]
        : [],
    );
  } catch (err) {
    console.error("[skills] could not load the catalog for a harness call:", err);
    return [];
  }
}
