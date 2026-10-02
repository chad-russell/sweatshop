import { openConversationSandbox } from "@/lib/sandboxes/binding";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * 0010 Phase 3: the bash tool's core. 0013: runs in the conversation's
 * binding — a pending project chat creates its own sandbox on first use
 * (then stays bound), an attached chat runs in the target's sandbox and
 * directory, and a chat with no sandbox gets a self-explanatory error.
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
  toolCallId?: string,
): Promise<BashResult> {
  const { handle } = await openConversationSandbox(
    conversationId,
    provider,
    toolCallId ? { toolCallId, tool: "bash" } : undefined,
  );
  const result = await handle.run(command);
  return {
    exitCode: result.exitCode,
    stdout: clipOutput(result.stdout),
    stderr: clipOutput(result.stderr),
  };
}
