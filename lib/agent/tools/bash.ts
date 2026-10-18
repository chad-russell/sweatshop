import { clipEnds } from "@/lib/clip";
import {
  openConversationSandbox,
  openInheritedSandbox,
  type BoundSandbox,
} from "@/lib/sandboxes/binding";

/** Clip a step-serialized result: keep the head and tail, drop the middle. */
export const clipOutput = clipEnds;
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
  const { handle } = await openConversationSandbox(conversationId, provider);
  const result = await handle.run(command);
  return {
    exitCode: result.exitCode,
    stdout: clipOutput(result.stdout),
    stderr: clipOutput(result.stderr),
  };
}

/** 0013: bash in an inherited binding on behalf of `sessionId` (an
 *  agent stage's visit conversation, running in the run's sandbox).
 *  Never binds, stops, or destroys anything. */
export async function runBashIn(
  sessionId: string,
  binding: BoundSandbox,
  command: string,
  provider?: SandboxProvider,
): Promise<BashResult> {
  const { handle } = await openInheritedSandbox(binding, provider);
  const result = await handle.run(command, undefined, binding.workDir);
  return {
    exitCode: result.exitCode,
    stdout: clipOutput(result.stdout),
    stderr: clipOutput(result.stderr),
  };
}
