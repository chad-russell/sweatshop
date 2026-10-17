import { db } from "@/db";
import { getConversationBinding } from "@/db/sandboxes";
import { openSandbox } from "@/lib/sandboxes/binding";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * Full child results, on disk (v7, per Chad — never inline text):
 * `saveResultFile` writes a settled harness call's or thread's whole
 * result into the PARENT conversation's sandbox, at a deterministic path
 * (`resultFilePath`), so the agent can `cat`/`grep`/`sed -n` it like any
 * file instead of only ever seeing a clipped wake. Mirrors the work-root
 * AGENTS.md write (`lib/sandboxes/workspace.ts`'s `writeWorkRootDoc`):
 * base64-piped so the content's own quoting never matters, `mkdir -p`
 * first. Same "bound only" rule as `loadRepoDocs`
 * (`lib/agent/tools/repo-docs.ts`): never provisions a sandbox just to
 * write this — a pending/none binding, or any failure to open or write
 * (stopped/destroyed sandbox, provider error) returns a reason instead
 * of throwing. A result file is a nice-to-have, never load-bearing: it
 * must never block or fail the wake that reports its path. Callers
 * persist `outcome.path` (or null) themselves — on `harness_calls` or
 * `conversations` — so a reader never has to guess whether a write
 * actually happened (review fix, 0040 phase 3 follow-up).
 */

/** Cap applied to the file's own content — matches `harness_calls.result`
 *  (0040 phase 3: both stop here; the web_fetch context limit). */
export const RESULT_FILE_CAP = 60_000;

/** The deterministic path a result lives at under a work root — pure, so
 *  a caller that just wrote one (the only legitimate use now — inspect
 *  and the wake sweep read the persisted path instead of deriving it)
 *  can compute it without a second round trip. Beside the repos, never
 *  inside one. */
export function resultFilePath(workDir: string, id: string): string {
  return `${workDir.replace(/\/+$/, "")}/.sweatshop/results/${id}.md`;
}

function capResultContent(content: string): string {
  if (content.length <= RESULT_FILE_CAP) return content;
  const cut = content.length - RESULT_FILE_CAP;
  return `${content.slice(0, RESULT_FILE_CAP)}\n\n…[${cut} more chars cut — the ${RESULT_FILE_CAP}-char file cap]`;
}

/** Why no file exists: the parent was never bound to begin with, or a
 *  bound sandbox refused the write (stopped/destroyed, provider error,
 *  non-zero exit). Lets the wake say which, instead of always blaming
 *  "no bound sandbox". */
export type NoResultFileReason = "unbound" | "write-failed";

export type SaveResultFileOutcome =
  | { path: string; chars: number }
  | { path: null; reason: NoResultFileReason };

/**
 * Write `content` to `<parent's workDir>/.sweatshop/results/<id>.md`.
 * `id` is the hc_… call id, or `<childId>-<settledAt>` for a thread (so
 * a re-woken child's later report never overwrites an earlier one).
 * Never throws; `chars` is the length actually written (post-cap).
 */
export async function saveResultFile(
  parentConversationId: string,
  id: string,
  content: string,
  provider?: SandboxProvider,
): Promise<SaveResultFileOutcome> {
  const binding = getConversationBinding(db(), parentConversationId);
  if (binding?.kind !== "bound") return { path: null, reason: "unbound" };
  try {
    const { handle, workDir } = await openSandbox(binding, provider);
    const path = resultFilePath(workDir, id);
    const dir = path.slice(0, path.lastIndexOf("/"));
    const capped = capResultContent(content);
    const encoded = Buffer.from(capped, "utf8").toString("base64");
    const result = await handle.run(`mkdir -p ${dir} && printf %s '${encoded}' | base64 -d > ${path}`);
    if (result.exitCode !== 0) {
      console.warn(`[result-file] ${parentConversationId}: write failed — ${result.stderr || result.stdout}`);
      return { path: null, reason: "write-failed" };
    }
    return { path, chars: capped.length };
  } catch (err) {
    console.warn(`[result-file] ${parentConversationId}: skipped — ${err instanceof Error ? err.message : String(err)}`);
    return { path: null, reason: "write-failed" };
  }
}
