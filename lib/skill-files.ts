import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 0054: synchronous reads of the git-shipped skill directory
 * (skills/<id>/SKILL.md) — the source `db/prompt-settings.ts` seeds
 * from and resets to. Synchronous on purpose: `getTarget`/`listTargets`
 * must be plain synchronous functions (callers compare `!current`
 * immediately, never awaiting), so seeding can't go through the
 * fs/promises API `lib/skills.ts` used before 0054.
 */

export const SKILL_ID = /^[a-z][a-z0-9-]{0,40}$/;

const ROOT = path.join(process.cwd(), "skills");

export interface GitSkillDefault {
  description: string;
  thread: boolean;
  body: string;
}

function parseFrontMatter(text: string): GitSkillDefault {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const body = (front ? text.slice(front[0].length) : text).trim();
  const header = front?.[1] ?? "";
  const description = /^description:\s*(.+)$/m.exec(header)?.[1].trim() ?? "";
  const thread = /^thread:\s*true\s*$/m.test(header);
  return { description, thread, body };
}

/** The current git default for a shipped skill, or null if it isn't one
 *  (bad id shape, no such directory, or not a file). */
export function readGitSkillDefault(id: string): GitSkillDefault | null {
  if (!SKILL_ID.test(id)) return null;
  try {
    const file = path.join(ROOT, id, "SKILL.md");
    if (!statSync(file).isFile()) return null;
    return parseFrontMatter(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Every git-shipped skill id (directory names under skills/), sorted. */
export function listGitSkillIds(): string[] {
  try {
    return readdirSync(ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((id) => SKILL_ID.test(id))
      .sort();
  } catch {
    return [];
  }
}

/** The body's first `# ` line — title is never stored, always derived. */
export function deriveSkillTitle(body: string, fallbackId: string): string {
  return /^#\s+(.+)$/m.exec(body)?.[1].trim() ?? fallbackId;
}
