import { renderOwnerPlaceholders } from "../../../lib/agent/owner";
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

/** The turn's `# Skills` appendix source — empty when unconfigured or down.
 *  0091 §2: rows carry `invoke`; listSkills already drops manual and
 *  disabled skills, so the appendix only ever sees auto + tool rows.
 *  0091 §3: ids attached to THIS send are excluded — their full bodies
 *  are already inlined in the turn's `# Attached skills` message, so
 *  the appendix must not double-list them. */
export async function loadSkillsCatalogStep(
  exclude?: readonly string[],
): Promise<{ id: string; description: string; invoke: "auto" | "tool" }[]> {
  "use step";
  const { listSkills } = await import("../../../lib/skills/store");
  try {
    const dropped = new Set(exclude ?? []);
    return (await listSkills())
      .filter(({ id }) => !dropped.has(id))
      .map(({ id, description, invoke }) => ({ id, description, invoke: invoke === "tool" ? "tool" : "auto" }));
  } catch {
    return [];
  }
}

/** 0091 §3: render the attached skills as one `# Attached skills`
 * section — attach is explicit intent, so the model gets the whole
 * runbook inlined (no use_skill round-trip), each under its id and
 * description. Pure: the step below reads, this renders. */
export function renderAttachedSkillsNote(
  skills: readonly { id: string; description: string; body: string }[],
): string {
  return [
    "# Attached skills",
    ...skills.map(({ id, description, body }) => `## ${id}\n\n${description}\n\n${renderOwnerPlaceholders(body)}`),
  ].join("\n\n");
}

/** 0091 §3: read the send's attached skills. Unknown, disabled, or
 * duplicate ids drop silently (a value, never a turn failure); the
 * rendered section (or null when nothing attaches) rides the user row's
 * metadata and is replayed verbatim on every later turn. */
export async function loadAttachedSkillsStep(
  ids: readonly string[],
): Promise<{ note: string | null; attached: string[] }> {
  "use step";
  const { readSkill } = await import("../../../lib/skills/store");
  const seen = new Set<string>();
  const loaded: { id: string; description: string; body: string }[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const skill = await readSkill(id);
    if (!skill || skill.disabled) continue;
    loaded.push({ id: skill.id, description: renderOwnerPlaceholders(skill.description), body: skill.body });
  }
  return { note: loaded.length > 0 ? renderAttachedSkillsNote(loaded) : null, attached: loaded.map((s) => s.id) };
}

/** List skills, load a skill body, or load one of its supporting files. */
export async function skillToolStep(_conversationId: string, id?: string, file?: string): Promise<unknown> {
  "use step";
  const [{ listSkills, readSkill }, { renderOwnerPlaceholders }] = await Promise.all([
    import("../../../lib/skills/store"),
    import("../../../lib/agent/owner"),
  ]);
  const listed = await listSkills();
  // 0091 §2: rows carry invoke so the model sees modes (manual skills
  // are not listed — but an explicit id read still reaches them below).
  const catalog = listed.map((s) => ({
    id: s.id,
    description: renderOwnerPlaceholders(s.description),
    invoke: s.invoke === "tool" ? ("tool" as const) : ("auto" as const),
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
