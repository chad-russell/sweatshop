import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * 0039: skills — markdown runbooks under skills/<id>/SKILL.md, read at
 * call time from the app's checkout (like system_docs). Front matter
 * carries `description` and, for a **thread skill**, `thread: true` —
 * bindable to a conversation as that thread's way of working: the body
 * joins the turn instructions and the step budget rises
 * (workflows/chat/turn.ts). Skills without `thread: true` are reference
 * material (the rest of roadmap 2.3 — grants, harness mounting — builds
 * on the same directory). Supersedes 0037's playbooks, folded in here.
 */

const ROOT = path.join(process.cwd(), "skills");
const ID = /^[a-z][a-z0-9-]{0,40}$/;

export interface Skill {
  id: string;
  title: string;
  description: string;
  /** A thread skill (front matter `thread: true`) can bind to a conversation. */
  thread: boolean;
  body: string;
}

function parse(id: string, text: string): Skill {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const body = (front ? text.slice(front[0].length) : text).trim();
  const header = front?.[1] ?? "";
  const description = /^description:\s*(.+)$/m.exec(header)?.[1].trim() ?? "";
  const thread = /^thread:\s*true\s*$/m.test(header);
  const title = /^#\s+(.+)$/m.exec(body)?.[1].trim() ?? id;
  return { id, title, description, thread, body };
}

export async function readSkill(id: string): Promise<Skill | null> {
  if (!ID.test(id)) return null;
  try {
    const file = path.join(ROOT, id, "SKILL.md");
    // A bare file is not a skill — the directory shape is the contract
    // 2.3's mounting work builds on.
    if (!(await stat(file)).isFile()) return null;
    return parse(id, await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function listSkills(): Promise<Skill[]> {
  const entries = (await readdir(ROOT, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const out: Skill[] = [];
  for (const id of entries) {
    const skill = await readSkill(id);
    if (skill) out.push(skill);
  }
  return out;
}

/** The bindable catalog: thread skills only (pickers, use_skill, start_thread). */
export async function listThreadSkills(): Promise<Skill[]> {
  return (await listSkills()).filter((s) => s.thread);
}
