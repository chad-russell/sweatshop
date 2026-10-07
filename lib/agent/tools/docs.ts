/**
 * Capability docs for the agent (the v1 of the 0026 skills idea):
 * markdown files in docs/agent/, tracked in git, read at call time
 * from the app's own checkout — so they always match the running
 * build. The turn instructions stay succinct and point here; the
 * agent pulls the depth it needs, when it needs it.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const DOCS_DIR = path.join(process.cwd(), "docs", "agent");

export interface DocTopic {
  topic: string;
  title: string;
}

/** One line per file, from its H1 — the tool's topic listing. */
export async function listDocTopics(): Promise<DocTopic[]> {
  const files = (await readdir(DOCS_DIR))
    .filter((f) => f.endsWith(".md"))
    .sort();
  const topics: DocTopic[] = [];
  for (const file of files) {
    const text = await readFile(path.join(DOCS_DIR, file), "utf8");
    const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? file.replace(/\.md$/, "");
    topics.push({ topic: file.replace(/\.md$/, ""), title });
  }
  return topics;
}

export type DocResult =
  | { ok: true; topic: string; doc: string }
  | { ok: false; code: string; message: string; topics: DocTopic[] };

/** Read one capability doc by topic (kebab-case file name). */
export async function readDoc(rawTopic: string): Promise<DocResult> {
  const topic = rawTopic.trim().toLowerCase();
  // The topic names a file under docs/agent — one path segment of
  // [a-z0-9-], never a traversal.
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(topic)) {
    return {
      ok: false,
      code: "bad-topic",
      message: `Unknown topic "${rawTopic}".`,
      topics: await listDocTopics(),
    };
  }
  try {
    const doc = await readFile(path.join(DOCS_DIR, `${topic}.md`), "utf8");
    return { ok: true, topic, doc };
  } catch {
    return {
      ok: false,
      code: "unknown-topic",
      message: `No doc for "${topic}".`,
      topics: await listDocTopics(),
    };
  }
}
