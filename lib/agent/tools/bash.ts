import { db } from "@/db";
import { getConversation } from "@/db/chat";
import { acquireConversationSandbox } from "@/lib/agent/tools/sandbox-pref";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * 0010 Phase 3: the bash tool's core (port of eve/tools/bash onto the
 * lease seam). A project conversation's dedicated sandbox is created on
 * first use and shared thereafter; unbound conversations get the same
 * self-explanatory error 0004 chose (the failure surfaces as whatever
 * tool call first touched the sandbox).
 *
 * Plain function on purpose: the workflow step is a thin wrapper, and
 * tests inject a fake provider here (step args must serialize, so the
 * provider can never ride through the workflow boundary).
 */

/** Clip a step-serialized result: keep the head and tail, drop the middle. */
export function clipOutput(text: string, limit = 10_000): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n… [${text.length - limit} chars clipped] …\n${text.slice(-half)}`;
}

export interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runBash(
  conversationId: string,
  command: string,
  provider?: SandboxProvider,
): Promise<BashResult> {
  const conversation = getConversation(db(), conversationId);
  if (!conversation?.projectId) {
    throw new Error(
      "no project bound to this conversation — bash is only available in project conversations (start one from a project page)",
    );
  }
  const { handle } = await acquireConversationSandbox(
    conversationId,
    conversation.projectId,
    provider,
  );
  const result = await handle.run(command);
  return {
    exitCode: result.exitCode,
    stdout: clipOutput(result.stdout),
    stderr: clipOutput(result.stderr),
  };
}
