import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * 0037: playbooks — markdown runbooks under docs/agent/playbooks/, read
 * at call time from the app's checkout (like system_docs). Front matter
 * carries one field, `description`; the H1 is the title. A thread that
 * runs one gets its body in the turn instructions and the background
 * step budget (workflows/chat/turn.ts). Folds into roadmap 2.3's skills.
 */

const DIR = path.join(process.cwd(), "docs", "agent", "playbooks");
const ID = /^[a-z][a-z0-9-]{0,40}$/;

export interface Playbook {
  id: string;
  title: string;
  description: string;
  body: string;
}

function parse(id: string, text: string): Playbook {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const body = (front ? text.slice(front[0].length) : text).trim();
  const description = /^description:\s*(.+)$/m.exec(front?.[1] ?? "")?.[1]?.trim() ?? "";
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? id;
  return { id, title, description, body };
}

export async function readPlaybook(id: string): Promise<Playbook | null> {
  if (!ID.test(id)) return null;
  try {
    return parse(id, await readFile(path.join(DIR, `${id}.md`), "utf8"));
  } catch {
    return null;
  }
}

export async function listPlaybooks(): Promise<Playbook[]> {
  const files = (await readdir(DIR).catch(() => [] as string[])).filter((f) => f.endsWith(".md")).sort();
  const out: Playbook[] = [];
  for (const file of files) {
    const book = await readPlaybook(file.slice(0, -3));
    if (book) out.push(book);
  }
  return out;
}
