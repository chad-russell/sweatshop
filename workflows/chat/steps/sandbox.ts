/**
 * Sandbox-bound tools: bash, PRs, previews, screenshots, inspect/exec.
 * Split from the old single steps.ts — every function
 * keeps its "use step" directive; Node/sqlite imports stay lazy inside
 * each step body, and relative imports stay relative (the workflow
 * bundle has no "@/" alias).
 */

import type { ModelMessage } from "ai";

/**
 * 0010 Phase 3: run a bash command in the conversation's dedicated
 * sandbox (created on first use). Output is clipped by the tool core
 * (step results serialize into the run log).
 */
export async function bashStep(
  conversationId: string,
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  "use step";
  const { runBash } = await import("../../../lib/agent/tools/bash");
  return runBash(conversationId, command);
}

/** 0010 Phase 3: open a PR on one of the bound project's repos (0004 D). */
export async function createPrStep(
  conversationId: string,
  input: {
    repo: string;
    head: string;
    base?: string;
    title: string;
    body?: string;
  },
): Promise<unknown> {
  "use step";
  const [{ db }, { getConversation }, { openProjectPR }] = await Promise.all([
    import("../../../db"),
    import("../../../db/chat"),
    import("../../../lib/git-hosts/open-pr"),
  ]);
  const projectId = getConversation(db(), conversationId)?.projectId;
  if (!projectId) throw new Error("no project bound to this conversation");
  // 0052: the host's answer at creation — the transcript copy stays true.
  const result = await openProjectPR({ projectId, ...input });
  return { ...result, state: "open" as const };
}

/** 0034 Phase A: validate a create_pr proposal and build the approval
 *  card text (commits + diffstat from the sandbox when bound). */
export async function createPrPreviewStep(
  conversationId: string,
  input: {
    repo: string;
    head: string;
    base?: string;
    title: string;
    body?: string;
  },
  /** 0037: the running turn's messages (screenshots attached this turn). */
  live: ModelMessage[] = [],
): Promise<unknown> {
  "use step";
  const { buildChatPRPreview } = await import("../../../lib/agent/tools/pr-preview");
  return buildChatPRPreview(conversationId, input, undefined, live);
}

/** 0016/0017: preview tools in this conversation's sandbox binding. */
export async function previewToolStep(
  conversationId: string,
  action: "start" | "status" | "stop" | "get-setup" | "save-setup",
  input: Record<string, unknown>,
): Promise<unknown> {
  "use step";
  const tools = await import("../../../lib/agent/tools/previews");
  const caller = { kind: "conversation" as const, conversationId };
  if (action === "start") return tools.startPreviewTool(caller, input);
  if (action === "status") return tools.previewStatusTool(caller, input);
  if (action === "get-setup") return tools.getPreviewSetupTool(caller);
  if (action === "save-setup") return tools.savePreviewSetupTool(caller, input as { definition: unknown });
  return tools.stopPreviewTool(caller, input as { id: string });
}

/** 0035: attach a sandbox PNG to the conversation. */
export async function screenshotStep(
  conversationId: string,
  input: { path: string; label?: string },
): Promise<unknown> {
  "use step";
  const tools = await import("../../../lib/agent/tools/screenshot");
  return tools.attachScreenshotTool(conversationId, input);
}

/** 0013 Phase 6: read-only look at another chat, run, or stage visit. */
export async function inspectStep(id: string): Promise<unknown> {
  "use step";
  const { inspectTarget } = await import("../../../lib/agent/tools/inspect");
  return inspectTarget(id);
}

/** 0013 Phase 6: one command in a named sandbox, without binding to it. */
export async function sandboxExecStep(
  target: string,
  command: string,
  workDir?: string,
): Promise<unknown> {
  "use step";
  const { sandboxExec } = await import("../../../lib/agent/tools/inspect");
  return sandboxExec(target, command, workDir ? { workDir } : {});
}
