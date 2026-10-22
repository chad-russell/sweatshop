/**
 * Sandbox-gated tools: bash, previews, screenshot, plan files, pi/claude/cursor/codex.
 */

import { tool } from "ai";
import { z } from "zod";
import { startHarnessCallStep } from "../harness-step";
import { possessive } from "../../../lib/agent/owner";
import { commandDescription } from "./shared";
import { bashStep, previewToolStep, screenshotStep } from "../steps";
import { previewTools } from "../preview-tools";
import { screenshotTool } from "../screenshot-tool";
import { planTools } from "../plan-tools";

export function sandboxTools(
  conversationId: string,
  hasSandbox: boolean,
  hasProject: boolean,
) {
  return {
    // 0011/0013: chats are not offered tools that can only error — bash
    // needs a sandbox binding; pi/claude also need a project.
    ...(hasSandbox && {
      bash: tool({
        description:
          "Run a bash command in this conversation's sandbox, in its working directory (a project " +
          "chat's own sandbox is created on first use with the repos cloned there; an attached chat " +
          "works in the sandbox and directory it attached to). Look around and check work with it " +
          "(read, grep, git, tests, builds, diffs); hand a real code change to a harness instead.",
        inputSchema: z.object({
          command: z.string().max(20_000).describe("The bash command to run."),
          description: commandDescription,
        }),
        execute: ({ command }) => bashStep(conversationId, command),
      }),
      // 0016: previews live in the sandbox, so they need one too.
      ...previewTools((action, input) => previewToolStep(conversationId, action, input)),
      // 0035: QA evidence shows in the conversation.
      attach_screenshot: screenshotTool((input) => screenshotStep(conversationId, input)),
      // 0041: the plan file lives in the sandbox's work root.
      ...planTools(conversationId),
    }),
    ...(hasSandbox && hasProject && {
      pi: tool({
        description:
          "Hand a coding task to the pi harness — it runs in the BACKGROUND in this conversation's " +
          "sandbox (repos under the work root) with its own read/write/edit/bash tools. Returns a " +
          "handle immediately; this conversation gets a \"[pi finished]\" message with the result when " +
          "it ends. pi keeps context across calls (a new call continues the same session). Check " +
          "progress with inspect (hc_… id); stop it with cancel_run. Use for non-trivial code changes; " +
          "use plain bash for quick commands — the repo state is shared. pi, claude, cursor and codex can " +
          "run at once in this chat, but they share this sandbox's checkout — give each one separate " +
          "files or areas; for work that could collide, use start_thread with fresh: true instead.",
        inputSchema: z.object({
          task: z.string().min(1).describe("The coding task, with enough context to act on."),
        }),
        execute: ({ task }) => startHarnessCallStep({ conversationId, kind: "pi", task }),
      }),

      claude: tool({
        description:
          "Hand a coding task to the Claude Code harness — it runs in the BACKGROUND in this " +
          "conversation's sandbox with its own read/edit/bash tools. Returns a handle immediately; " +
          "this conversation gets a \"[claude finished]\" message with the result when it ends. " +
          "claude keeps context across calls. Prefer for deep refactors or nuanced code review; use " +
          "pi for quick edits and plain bash for one-off commands. inspect (hc_…) checks progress; " +
          "cancel_run stops it. pi, claude, cursor and codex can run at once in this chat, but they " +
          "share this sandbox's checkout — give each one separate files or areas; for work that could " +
          "collide, use start_thread with fresh: true instead.",
        inputSchema: z.object({
          task: z.string().min(1).describe("The coding task, with enough context to act on."),
        }),
        execute: ({ task }) => startHarnessCallStep({ conversationId, kind: "claude", task }),
      }),

      cursor: tool({
        description:
          "Hand a coding task to the Cursor agent harness — it runs in the BACKGROUND in this " +
          "conversation's sandbox with Cursor's own read/edit/shell tools. Returns a handle " +
          "immediately; this conversation gets a \"[cursor finished]\" message with the result when " +
          `it ends. cursor keeps context across calls. Needs ${possessive()} Cursor login (it errors ` +
          "value-shaped when not logged in). inspect (hc_…) checks progress; cancel_run stops it. " +
          "pi, claude, cursor and codex can run at once in this chat, but they share this sandbox's " +
          "checkout — give each one separate files or areas; for work that could collide, use " +
          "start_thread with fresh: true instead.",
        inputSchema: z.object({
          task: z.string().min(1).describe("The coding task, with enough context to act on."),
        }),
        execute: ({ task }) => startHarnessCallStep({ conversationId, kind: "cursor", task }),
      }),

      codex: tool({
        description:
          "Hand a coding task to the Codex CLI agent — it runs in the BACKGROUND in this " +
          "conversation's sandbox with its own read/write/edit/bash tools. Returns a handle " +
          "immediately; this conversation gets a \"[codex finished]\" message with the result when " +
          "it ends. codex keeps context across calls. Needs a ChatGPT login (it errors " +
          "value-shaped when not logged in). inspect (hc_…) checks progress; cancel_run stops it. " +
          "pi, claude, cursor and codex can run at once in this chat, but they share this sandbox's " +
          "checkout — give each one separate files or areas; for work that could collide, use " +
          "start_thread with fresh: true instead.",
        inputSchema: z.object({
          task: z.string().min(1).describe("The coding task, with enough context to act on."),
        }),
        execute: ({ task }) => startHarnessCallStep({ conversationId, kind: "codex", task }),
      }),
    }),
  };
}
