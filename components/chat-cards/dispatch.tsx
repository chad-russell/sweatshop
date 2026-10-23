"use client";

import type { ReactNode } from "react";
import type { ToolUIPart } from "ai";
import { BashTerminal } from "@/components/ai-elements/bash-terminal";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import {
  InspectCard,
  HostExecCard,
  SandboxExecCard,
  StartThreadCard,
} from "@/components/ai-elements/agent-cards";
import { PreviewToolCard } from "@/components/previews/preview-card";
import {
  CancelRunCard,
  NoteCard,
  DocsCard,
  PreviewSetupCard,
  ProjectsCard,
  QueryTerminal,
  SkillCard,
} from "@/components/ai-elements/info-cards";
import type { ToolState } from "@/lib/tool-views/inspect";

/**
 * Tool-call dispatch for the transcript — the designed card for a
 * machine / run / inspect tool call, and the generic fallback card —
 * split from chat-session.tsx.
 */

const AGENT_TOOLS = new Set([
  "start_thread",
  "inspect",
  "sandbox_exec",
  "exec",
  "start_preview",
  "preview_status",
  "stop_preview",
  "use_skill",
  "system_docs",
  "list_projects",
  "get_preview_setup",
  "save_preview_setup",
  "gh",
  "forgejo",
  "cancel_run",
  "note",
]);

/** The designed card for a machine / run / inspect tool call, if it has one. */
export function agentToolCard(part: ToolUIPart): ReactNode {
  const name = part.type.replace(/^tool-/, "");
  if (!AGENT_TOOLS.has(name)) return null;
  const state: ToolState =
    part.state === "output-available" ? "completed" : part.state === "output-error" || part.state === "output-denied" ? "error" : "running";
  const shared = {
    state,
    input: part.state === "input-streaming" ? undefined : part.input,
    output: part.state === "output-available" ? part.output : undefined,
    errorText: part.state === "output-error" ? (part.errorText ?? "tool failed") : part.state === "output-denied" ? "denied" : undefined,
  };
  switch (name) {
    case "start_thread":
      return <StartThreadCard {...shared} />;
    case "inspect":
      return <InspectCard {...shared} />;
    case "sandbox_exec":
      return <SandboxExecCard {...shared} />;
    case "exec":
      return <HostExecCard {...shared} />;
    case "start_preview":
    case "preview_status":
    case "stop_preview":
      return <PreviewToolCard tool={name} {...shared} />;
    case "use_skill":
      return <SkillCard {...shared} />;
    case "system_docs":
      return <DocsCard {...shared} />;
    case "list_projects":
      return <ProjectsCard {...shared} />;
    case "get_preview_setup":
    case "save_preview_setup":
      return <PreviewSetupCard tool={name} {...shared} />;
    case "gh":
    case "forgejo":
      return <QueryTerminal tool={name} {...shared} />;
    case "cancel_run":
      return <CancelRunCard {...shared} />;
    case "note":
      return <NoteCard {...shared} />;
    default:
      return null;
  }
}

/** One tool call, collapsed by default. */
export const ToolCallView = ({ part }: { part: ToolUIPart }) => {
  const input = part.state === "input-streaming" ? undefined : part.input;
  const output = part.state === "output-available" ? part.output : undefined;
  const errorText = part.state === "output-error" ? (part.errorText ?? "tool failed") : undefined;
  const toolName = part.type.replace(/^tool-/, "");
  if (toolName === "bash") {
    return (
      <BashTerminal
        className="my-1"
        state={part.state}
        input={input}
        output={output}
        errorText={errorText}
      />
    );
  }
  return (
    <Tool>
      <ToolHeader
        type="dynamic-tool"
        state={part.state}
        toolName={part.type.replace(/^tool-/, "")}
      />
      <ToolContent>
        {input !== undefined && <ToolInput input={input} />}
        {(output !== undefined || errorText !== undefined) && (
          <ToolOutput output={output} errorText={errorText} />
        )}
      </ToolContent>
    </Tool>
  );
};
