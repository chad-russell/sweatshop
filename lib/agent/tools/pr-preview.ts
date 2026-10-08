import { db } from "@/db";
import { getConversation } from "@/db/chat";
import { getConversationBinding } from "@/db/sandboxes";
import { openConversationSandbox } from "@/lib/sandboxes/binding";
import { resolveProjectRepo } from "@/lib/git-hosts/open-pr";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

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
  | { ok: true; summary: string }
  | {
      ok: false;
      code: "no-project" | "no-repo" | "no-credential";
      message: string;
    };

/** Ref/dir names safe to interpolate into the sandbox shell command. */
const SAFE_NAME = /^[A-Za-z0-9._/-]+$/;

function clipLines(text: string, max: number): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= max) return lines.join("\n");
  return `${lines.slice(0, max).join("\n")}\n… (+${lines.length - max} more)`;
}

/** The card text — pure; `git` carries what the sandbox gather returned. */
export function formatPRSummary(
  input: PRPreviewInput,
  git?: { log?: string; stat?: string; note?: string },
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
  if (git?.stat?.trim()) {
    lines.push("", "Diffstat:", clipLines(git.stat, 15));
  }
  if (git?.note) lines.push("", `(${git.note})`);
  return lines.join("\n").slice(0, 3_500);
}

/** Read the branch's commits + diffstat from the conversation's sandbox. */
async function gatherGitSummary(
  conversationId: string,
  input: PRPreviewInput,
  provider?: SandboxProvider,
): Promise<{ log?: string; stat?: string; note?: string }> {
  // Only a BOUND conversation has a sandbox to read from — pending
  // would provision one (clone repos) just to summarize, and none has
  // nothing to read. Neither belongs in an approval preview.
  const binding = getConversationBinding(db(), conversationId);
  if (!binding || binding.kind !== "bound") {
    return { note: "no sandbox bound — commit summary unavailable" };
  }
  for (const name of [input.repo, input.head, input.base ?? "main"]) {
    if (!SAFE_NAME.test(name)) {
      return { note: `unusual name "${name}" — commit summary skipped` };
    }
  }
  try {
    const { handle } = await openConversationSandbox(conversationId, provider);
    const base = input.base ?? "main";
    const log = await handle.run(
      `git -C ${input.repo} log --oneline -16 ${base}..${input.head}`,
    );
    const stat = await handle.run(
      `git -C ${input.repo} diff --stat ${base}...${input.head} | tail -16`,
    );
    if (log.exitCode !== 0 || stat.exitCode !== 0) {
      const err = log.exitCode !== 0 ? log.stderr : stat.stderr;
      return {
        note: `commit summary unavailable (${err.trim().split("\n")[0] || "git error"})`,
      };
    }
    return { log: log.stdout, stat: stat.stdout };
  } catch (err) {
    return {
      note: `commit summary unavailable (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/** Validate the proposal and build the approval card text. */
export async function buildChatPRPreview(
  conversationId: string,
  input: PRPreviewInput,
  provider?: SandboxProvider,
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
  return { ok: true, summary: formatPRSummary(input, git) };
}
