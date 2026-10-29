import { diffLines } from "../../../lib/text-diff";
import type { PromptChangeCard } from "./prompt-change";

/**
 * 0088: the chat's skill steps over `lib/skills/store.ts` — the instructions
 * appendix catalog, `use_skill` reads, and `save_skill`'s preview/apply
 * pair. Every result is value-shaped; a dead store reads as an empty
 * catalog, never a throw into a turn.
 */

export interface SkillSaveInput {
  id: string;
  body: string;
  files?: { path: string; content: string }[];
  note?: string;
}

/** The turn's `# Skills` appendix source — empty when unconfigured or down. */
export async function loadSkillsCatalogStep(): Promise<{ id: string; description: string }[]> {
  "use step";
  const { listSkills } = await import("../../../lib/skills/store");
  try {
    return (await listSkills()).map(({ id, description }) => ({ id, description }));
  } catch {
    return [];
  }
}

/** List skills, load a skill body, or load one of its supporting files. */
export async function skillToolStep(_conversationId: string, id?: string, file?: string): Promise<unknown> {
  "use step";
  const [{ listSkills, readSkill }, { renderOwnerPlaceholders }] = await Promise.all([
    import("../../../lib/skills/store"),
    import("../../../lib/agent/owner"),
  ]);
  const listed = await listSkills();
  const catalog = listed.map((s) => ({
    id: s.id,
    description: renderOwnerPlaceholders(s.description),
    files: s.files,
  }));
  if (!id) return { ok: true, skills: catalog };
  const skill = await readSkill(id);
  if (!skill || skill.disabled) {
    return { ok: false, code: "unknown-skill", message: `No active skill "${id}".`, skills: catalog };
  }
  if (file !== undefined) {
    const found = skill.fileContents.find((f) => f.path === file);
    if (!found) {
      return {
        ok: false,
        code: "unknown-file",
        message: `Skill "${id}" has no file "${file}".${skill.files.length > 0 ? ` Files: ${skill.files.join(", ")}.` : " It has no supporting files."}`,
        files: skill.files,
      };
    }
    return { ok: true, id, file, content: renderOwnerPlaceholders(found.content) };
  }
  const body = renderOwnerPlaceholders(skill.body);
  return {
    ok: true,
    id,
    skill: skill.files.length > 0 ? `${body}\n\nFiles: ${skill.files.join(", ")}` : body,
    ...(skill.files.length > 0 ? { files: skill.files } : {}),
  };
}

/** One text rendering of a skill (SKILL.md then each file) so a single line diff covers every file. */
function render(files: { path: string; content: string }[]): string {
  return files.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n");
}

/** Validate and snapshot a proposal before an approval row opens. */
export async function saveSkillPreviewStep(input: SkillSaveInput) {
  "use step";
  const { readSkill, status, validateSkillInput } = await import("../../../lib/skills/store");
  const issues = validateSkillInput(input);
  if (issues.length > 0) {
    return { ok: false as const, code: "invalid" as const, issues, message: issues.join("; ") };
  }
  if (!(await status()).configured) {
    return {
      ok: false as const,
      code: "unconfigured" as const,
      message: "The skills store is not configured (SKILLS_S3_* env) — nothing can be saved.",
    };
  }
  const existing = await readSkill(input.id);
  const next = [{ path: "SKILL.md", content: input.body }, ...(input.files ?? [])];
  const before = existing ? [{ path: "SKILL.md", content: existing.raw }, ...existing.fileContents] : [];
  const title = `${existing ? "Change" : "Create"} skill ${input.id}`;
  const card: PromptChangeCard = {
    kind: "prompt_change",
    target: { kind: "skill", id: input.id },
    title,
    currentVersion: existing ? 1 : 0,
    patch: { body: input.body },
    before: null,
    diff: existing
      ? diffLines(render(before), render(next))
      : render(next).split("\n").map((text) => ({ op: "add" as const, text })),
  };
  return { ok: true as const, summary: `${title}. Review the complete proposed change below.`, card };
}

/** Write the exact approved snapshot. */
export async function saveSkillApplyStep(input: SkillSaveInput) {
  "use step";
  const { saveSkill } = await import("../../../lib/skills/store");
  return saveSkill({ id: input.id, body: input.body, files: input.files, author: "agent" });
}
