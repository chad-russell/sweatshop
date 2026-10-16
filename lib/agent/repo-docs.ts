import type { SandboxShell } from "@/lib/sandbox-shell";

/**
 * Shared caps and read helper for a repo's AGENTS.md, as surfaced to both
 * the top-level chat agent (workflows/chat/instructions.ts — a per-repo
 * appendix, with an overall total cap too) and the harnesses' work-root
 * doc (lib/sandboxes/workspace.ts — inlined, per-file cap only). One
 * place so both stay in budget and cut files point the same way.
 */

/** Per-file cap: about 24 KB. */
export const REPO_DOC_FILE_CAP = 24 * 1024;
/** Cap on the total appended to the chat agent's instructions: about 48 KB. */
export const REPO_DOC_TOTAL_CAP = 48 * 1024;

export interface RepoDoc {
  repo: string;
  /** Absolute path inside the sandbox, e.g. /work/<conv>/<repo>/AGENTS.md */
  path: string;
  content: string;
}

/** Truncate `content` to `limit`, leaving a pointer to the full file when
 *  cut — so the agent (or harness) can `cat` the rest itself. */
export function capRepoDoc(content: string, fullPath: string, limit: number = REPO_DOC_FILE_CAP): string {
  if (content.length <= limit) return content;
  return `${content.slice(0, limit)}\n\n… [cut at ${Math.round(limit / 1024)} KB — read the rest: cat ${fullPath}]`;
}

function quote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Read a file capped at `limit` bytes (+1, so a caller can tell a cut
 * happened via `content.length > limit`). A missing file or any read
 * error is `null`, never thrown — a repo without an AGENTS.md is normal.
 */
export async function readCappedFile(
  shell: SandboxShell,
  path: string,
  limit: number = REPO_DOC_FILE_CAP,
): Promise<string | null> {
  const result = await shell.run(`head -c ${limit + 1} ${quote(path)} 2>/dev/null`);
  return result.exitCode === 0 ? result.stdout : null;
}
