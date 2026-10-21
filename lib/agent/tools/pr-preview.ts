import { db } from "@/db";
import { getConversation } from "@/db/chat";
import { getConversationBinding } from "@/db/sandboxes";
import { openConversationSandbox } from "@/lib/sandboxes/binding";
import { resolveProjectRepo } from "@/lib/git-hosts/open-pr";
import type { SandboxProvider } from "@/lib/sandboxes/provider";
import { buildApprovalEvidence, describeCheck, type ApprovalEvidence } from "./evidence";
import { clipLines } from "@/lib/clip";
import { classifyDiff, parseNumstatZ, type DiffBreakdown } from "@/lib/diff-breakdown";

/**
 * 0034 Phase A: the approval preview for create_pr — validate the
 * proposal and build the card Chad decides on: repo, head→base, title,
 * and (when the conversation has a sandbox with the repo in it) the
 * commits and diffstat of the branch. The turn's create_pr tool calls
 * this before suspending on the ask_chad hook, exactly like
 * create_machine's preview. Formatting is split out for tests.
 */

export interface PRPreviewInput {
  repo: string;
  head: string;
  base?: string;
  title: string;
  body?: string;
}

export type PRPreview =
  | { ok: true; summary: string; evidence: ApprovalEvidence }
  | {
      ok: false;
      code: "no-project" | "no-repo" | "no-credential" | "no-such-branch";
      message: string;
    };

/** Ref/dir names safe to interpolate into the sandbox shell command. */
const SAFE_NAME = /^[A-Za-z0-9._/-]+$/;

/** A compact "Category  N files  +A −D" table plus a Total row, replacing
 *  the clipped `--stat` blob (0059) — the text form carries the same
 *  breakdown the UI chip shows. */
function formatBreakdownTable(breakdown: DiffBreakdown): string {
  const rows = [
    ...breakdown.categories.map((c) => ({ label: c.label, files: c.files, added: c.added, deleted: c.deleted })),
    { label: "Total", files: breakdown.files, added: breakdown.added, deleted: breakdown.deleted },
  ];
  return rows.map((r) => `${r.label}  ${r.files} files  +${r.added} −${r.deleted}`).join("\n");
}

/** The card text — pure; `git` carries what the sandbox gather returned. */
export function formatPRSummary(
  input: PRPreviewInput,
  git?: { log?: string; breakdown?: DiffBreakdown; note?: string },
): string {
  const lines = [
    `Open a pull request on "${input.repo}": ${input.title}`,
    `${input.head} → ${input.base ?? "main"}`,
  ];
  if (input.body?.trim()) {
    lines.push(`Body: ${input.body.trim().split("\n")[0]!.slice(0, 200)}`);
  }
  if (git?.log?.trim()) {
    lines.push("", "Commits:", clipLines(git.log, 15));
  }
  if (git?.breakdown && git.breakdown.files > 0) {
    lines.push("", "Diff:", formatBreakdownTable(git.breakdown));
  }
  if (git?.note) lines.push("", `(${git.note})`);
  return lines.join("\n").slice(0, 3_500);
}

/** The summary gather over any command runner (a live sandbox handle) —
 *  shared with the propose_pr tool's `summarize` closures. */
export async function runGitSummary(
  run: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  repo: string,
  head: string,
  base?: string,
): Promise<{ log?: string; breakdown?: DiffBreakdown; note?: string; missingHead?: true }> {
  for (const name of [repo, head, base ?? "main"]) {
    if (!SAFE_NAME.test(name)) {
      return { note: `unusual name "${name}" — commit summary skipped` };
    }
  }
  try {
    const target = base ?? "main";
    const exists = await run(`git -C ${repo} rev-parse --verify --quiet refs/heads/${head}`);
    if (exists.exitCode !== 0) return { missingHead: true, note: `branch "${head}" does not exist` };
    const log = await run(`git -C ${repo} log --oneline -16 ${target}..${head}`);
    const numstat = await run(`git -C ${repo} diff --numstat -z ${target}...${head}`);
    if (log.exitCode !== 0 || numstat.exitCode !== 0) {
      const err = log.exitCode !== 0 ? log.stderr : numstat.stderr;
      return {
        note: `commit summary unavailable (${err.trim().split("\n")[0] || "git error"})`,
      };
    }
    return { log: log.stdout, breakdown: classifyDiff(parseNumstatZ(numstat.stdout)) };
  } catch (err) {
    return {
      note: `commit summary unavailable (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/** Read the branch's commits + diffstat from the conversation's sandbox. */
async function gatherGitSummary(
  conversationId: string,
  input: PRPreviewInput,
  provider?: SandboxProvider,
): Promise<{ log?: string; breakdown?: DiffBreakdown; note?: string; missingHead?: true }> {
  // Only a BOUND conversation has a sandbox to read from — pending
  // would provision one (clone repos) just to summarize, and none has
  // nothing to read. Neither belongs in an approval preview.
  const binding = getConversationBinding(db(), conversationId);
  if (!binding || binding.kind !== "bound") {
    return { note: "no sandbox bound — commit summary unavailable" };
  }
  return runGitSummary(
    (command) =>
      openConversationSandbox(conversationId, provider).then((opened) => opened.handle.run(command)),
    input.repo,
    input.head,
    input.base,
  );
}

/** Validate the proposal and build the approval card text. */
export async function buildChatPRPreview(
  conversationId: string,
  input: PRPreviewInput,
  provider?: SandboxProvider,
  /** 0037: the running turn's messages (its attachments are not
   *  persisted yet). */
  live: readonly import("ai").ModelMessage[] = [],
): Promise<PRPreview> {
  const conversation = getConversation(db(), conversationId);
  if (!conversation?.projectId) {
    return {
      ok: false,
      code: "no-project",
      message: "no project bound to this conversation",
    };
  }
  const resolved = resolveProjectRepo(conversation.projectId, input.repo);
  if (!resolved.ok) return resolved;
  const git = await gatherGitSummary(conversationId, input, provider);
  // Run 7: a head that does not exist in the checkout is the model's
  // typo — return it to the model to repair, never put a commit-less
  // card in front of Chad.
  if (git.missingHead) {
    return {
      ok: false,
      code: "no-such-branch",
      message: `branch "${input.head}" does not exist in ${input.repo} — check \`git branch\` and call create_pr with the branch your commits are on`,
    };
  }
  // 0037: the runtime's own evidence — the test command and the
  // thread's screenshots — so the card shows what the model skipped.
  // 0059: the sandbox's own diff breakdown rides along too.
  const evidence: ApprovalEvidence = {
    ...(await buildApprovalEvidence(conversationId, input.repo, provider, live)),
    breakdown: git.breakdown,
  };
  const shots = evidence.screenshots.length;
  const summary = `${formatPRSummary(input, git)}\n\nChecks: ${describeCheck(evidence)}\nScreenshots: ${shots === 0 ? "none attached in this thread" : shots}`;
  return { ok: true, summary, evidence };
}
