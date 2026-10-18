/**
 * Host channel (0043): exec steps and the auto-approve read. Split from the old single steps.ts - every function
 * keeps its "use step" directive; Node/sqlite imports stay lazy inside
 * each step body, and relative imports stay relative (the workflow
 * bundle has no "@/" alias).
 */

import { chatStore } from "../deps";

/** 0043: validate an exec proposal and build the approval card text
 *  (validates WITHOUT connecting — Chad never approves an exec that
 *  cannot run). */
export async function hostExecPreviewStep(
  conversationId: string,
  input: import("../../../lib/agent/tools/host").HostExecInput,
): Promise<unknown> {
  "use step";
  const { hostExecPreview } = await import("../../../lib/agent/tools/host");
  return hostExecPreview(conversationId, input);
}

/** 0043: run the approved (or auto-approved) exec — audit row, transport,
 *  TOFU pin, clip. */
export async function hostExecStep(
  conversationId: string,
  input: import("../../../lib/agent/tools/host").HostExecInput,
  /** 0043 amendment: this call skipped ask_chad under the chat's toggle. */
  autoApproved = false,
): Promise<unknown> {
  "use step";
  const { hostExecRun } = await import("../../../lib/agent/tools/host");
  return hostExecRun(conversationId, input, undefined, autoApproved);
}

/**
 * 0043 amendment: this chat's exec-approval toggle, read on EVERY exec
 * call (not cached per turn) so flipping it takes effect on the very
 * next command.
 */
export async function getHostAutoApproveStep(conversationId: string): Promise<boolean> {
  "use step";
  const { db, chat } = await chatStore();
  return chat.getHostAutoApprove(db, conversationId);
}
