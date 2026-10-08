import type { ModelMessage } from "ai";
import { chatStore } from "./deps";

/**
 * 0010 spike turn side effects — every function here is a `"use step"`
 * (replay-safe via recorded results); Node/sqlite imports happen inside
 * (through ./deps loaders), same pattern as workflows/machines/steps.ts.
 * The workflow body (turn.ts) only orchestrates.
 *
 * Relative imports throughout: this tree is compiled into the workflow
 * bundle, where the "@/" alias is not guaranteed outside Next.
 */

/**
 * Load the conversation's model history. Steer rows queued while no turn
 * was running are folded in as user messages first (and persisted), so a
 * message that arrived "between turns" is never lost. 0015: user rows'
 * viewing notes are injected as system messages (listTurnMessages).
 */
export async function loadTurnHistory(
  conversationId: string,
): Promise<ModelMessage[]> {
  "use step";
  const { db, chat } = await chatStore();
  const queued = chat.drainSteer(db, conversationId);
  if (queued.length > 0) {
    chat.appendMessages(
      db,
      conversationId,
      queued.map((text, i) => ({
        id: `sq_${conversationId}_${Date.now()}_${i}`,
        role: "user" as const,
        text,
        modelMessage: { role: "user", content: text },
      })),
    );
  }
  return chat.listTurnMessages(db, conversationId);
}

/**
 * Persist the turn's user message. Id is keyed on the conversation's
 * persisted-history length — stable for a given run (replay-safe), never
 * colliding across turns (history only grows). 0015: the send's viewing
 * context rides as row metadata (the note is rebuilt from it each turn).
 */
export async function recordUserMessage(
  conversationId: string,
  text: string,
  seq: number,
  viewing?: import("../../lib/page-context").ViewingContext,
  runEvent?: import("../../db/chat").RunEventMeta,
): Promise<void> {
  "use step";
  const { db, chat } = await chatStore();
  chat.appendMessages(db, conversationId, [
    {
      id: `t_${conversationId}_${seq}`,
      role: "user",
      text,
      modelMessage: { role: "user", content: text },
      ...(viewing ? { metadata: { viewing } } : {}),
      ...(runEvent ? { metadata: { runEvent } } : {}),
    },
  ]);
}

/**
 * Drain the steer queue for the running turn (mid-turn injection, called
 * from the turn's prepareStep before each model step after the first).
 * A step — not a helper — because only step bodies may touch sqlite; the
 * recorded result also makes a replayed turn re-inject the same steer
 * messages deterministically. Injected messages are persisted by
 * persistTurn (they appear in the agent's final message list).
 */
export async function drainSteerStep(conversationId: string): Promise<string[]> {
  "use step";
  const { db, chat } = await chatStore();
  return chat.drainSteer(db, conversationId);
}

/**
 * End the turn's durable stream: one UI `finish`, then close. The turn
 * streams every slice with `preventClose` + `sendFinish: false` (the
 * vendored ChatSessionModeling pattern) — the default closes the stream
 * after the FIRST slice, so the browser saw one slice of a long turn and
 * the rest only on reload (2026-10-07). A step because only step bodies
 * may write to a stream.
 */
export async function finishTurnStream(
  writable: WritableStream<import("@ai-sdk/workflow").ModelCallStreamPart>,
): Promise<void> {
  "use step";
  const writer = writable.getWriter();
  try {
    // Not a ModelCallStreamPart member: the SDK's own closeStream writes
    // this same bare chunk, which the UI transform passes through.
    await writer.write({ type: "finish" } as unknown as import("@ai-sdk/workflow").ModelCallStreamPart);
  } finally {
    writer.releaseLock();
  }
  await writable.close();
}

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
  const { runBash } = await import("../../lib/agent/tools/bash");
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
    import("../../db"),
    import("../../db/chat"),
    import("../../lib/git-hosts/open-pr"),
  ]);
  const projectId = getConversation(db(), conversationId)?.projectId;
  if (!projectId) throw new Error("no project bound to this conversation");
  return openProjectPR({ projectId, ...input });
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
): Promise<unknown> {
  "use step";
  const { buildChatPRPreview } = await import("../../lib/agent/tools/pr-preview");
  return buildChatPRPreview(conversationId, input);
}

/** 1.5 (roadmap): fetch one web page — plain HTTP, capped, HTML stripped. */
export async function webFetchStep(url: string): Promise<unknown> {
  "use step";
  const { fetchWebPage } = await import("../../lib/agent/tools/web");
  return fetchWebPage(url);
}

/** 1.5 (roadmap): search the web through Z.AI's coding-plan MCP tool. */
export async function webSearchStep(
  query: string,
  opts: { recency?: import("../../lib/agent/tools/web-search").Recency; domain?: string },
): Promise<unknown> {
  "use step";
  const { searchWeb } = await import("../../lib/agent/tools/web-search");
  return searchWeb(query, opts);
}

/** The agent's capability docs (docs/agent/*.md), read from the checkout. */
export async function systemDocsStep(topic?: string): Promise<unknown> {
  "use step";
  const { listDocTopics, readDoc } = await import("../../lib/agent/tools/docs");
  if (topic === undefined || topic === "") return { ok: true, topics: await listDocTopics() };
  return readDoc(topic);
}

/** 0033: run one read-only gh command with the stored github credential. */
export async function ghStep(args: string[]): Promise<unknown> {
  "use step";
  const { runGh } = await import("../../lib/agent/tools/gh");
  return runGh(args);
}

/** 0033 A′: one read-only forgejo API GET on the stored credential. */
export async function forgejoStep(path: string, params: Record<string, string>): Promise<unknown> {
  "use step";
  const { runForgejo } = await import("../../lib/agent/tools/forgejo");
  return runForgejo(path, params);
}

/** 0033 B: the create input shared by the preview and create steps. */
export interface CreateProjectToolInput {
  id: string;
  name: string;
  description?: string | null;
  repos?: { name: string; url: string }[];
  testCommand?: string | null;
  branchPrefix?: string | null;
  defaultRoute?: unknown;
}

/** 0033 B: list every project with its repos and work defaults. */
export async function listProjectsStep(): Promise<unknown> {
  "use step";
  const { listProjectsTool } = await import("../../lib/agent/tools/projects");
  return listProjectsTool();
}

/** 0033 B: validate a create (the approval preview renders its summary). */
export async function createProjectPreviewStep(input: CreateProjectToolInput): Promise<unknown> {
  "use step";
  const { createProjectPreview } = await import("../../lib/agent/tools/projects");
  return createProjectPreview(input);
}

/** 0033 B: create the approved project (repos atomically, then extras). */
export async function createProjectStep(input: {
  id: string;
  name: string;
  description?: string | null;
  repos?: { name: string; url: string }[];
  testCommand?: string | null;
  branchPrefix?: string | null;
  defaultRoute?: unknown;
}): Promise<unknown> {
  "use step";
  const [{ db }, { createProject, setProjectWorkSettings }, { setProjectModelSettings }] = await Promise.all([
    import("../../db"),
    import("../../db/projects"),
    import("../../lib/providers/settings"),
  ]);
  const created = createProject(db(), input);
  if (!created.ok) return created;
  if (input.testCommand !== undefined || input.branchPrefix !== undefined) {
    setProjectWorkSettings(db(), created.project.id, {
      ...(input.testCommand !== undefined ? { testCommand: input.testCommand } : {}),
      ...(input.branchPrefix !== undefined ? { branchPrefix: input.branchPrefix } : {}),
    });
  }
  if (input.defaultRoute !== undefined) {
    setProjectModelSettings(db(), created.project.id, { defaultRoute: input.defaultRoute });
  }
  return created;
}

/** 0033 B: apply an edit batch (partial, with a refusal report). */
export async function editProjectStep(
  input: Parameters<(typeof import("../../lib/agent/tools/projects"))["editProjectTool"]>[0],
): Promise<unknown> {
  "use step";
  const { editProjectTool } = await import("../../lib/agent/tools/projects");
  return editProjectTool(input);
}

/** 0033 B: the delete cascade preview Chad approves. */
export async function deleteProjectPreviewStep(projectId: string): Promise<unknown> {
  "use step";
  const { deleteProjectPreview } = await import("../../lib/agent/tools/projects");
  return deleteProjectPreview(projectId);
}

/** 0033 B: run the approved delete cascade. */
export async function deleteProjectStep(projectId: string): Promise<unknown> {
  "use step";
  const { deleteProjectFully } = await import("../../lib/projects");
  return deleteProjectFully(projectId);
}

/** 0010 Phase 3: machines available in this conversation (0009). */
export async function listMachinesStep(
  conversationId: string,
): Promise<unknown> {
  "use step";
  const { listAvailableMachines } = await import("../../lib/agent/tools/start-machine");
  return listAvailableMachines(conversationId);
}

/** 0010 Phase 3: start a machine run directly, in-process (0009). */
export async function startMachineStep(
  conversationId: string,
  input: { machineId: string; prompt: string; fresh?: boolean; overrides?: unknown },
): Promise<{ runId: string; url: string; sandbox: "inherited" | "own" | "none" }> {
  "use step";
  const { startMachineRun } = await import("../../lib/agent/tools/start-machine");
  return startMachineRun({ conversationId, ...input });
}

/** 0022: cancel a run the agent started (or watches). */
export async function cancelRunStep(runId: string): Promise<unknown> {
  "use step";
  const { cancelRunTool } = await import("../../lib/agent/tools/cancel-run");
  return cancelRunTool(runId);
}

/** 0016/0017: preview tools in this conversation's sandbox binding. */
export async function previewToolStep(
  conversationId: string,
  action: "start" | "status" | "stop" | "get-setup" | "save-setup",
  input: Record<string, unknown>,
): Promise<unknown> {
  "use step";
  const tools = await import("../../lib/agent/tools/previews");
  const caller = { kind: "conversation" as const, conversationId };
  if (action === "start") return tools.startPreviewTool(caller, input);
  if (action === "status") return tools.previewStatusTool(caller, input);
  if (action === "get-setup") return tools.getPreviewSetupTool(caller);
  if (action === "save-setup") return tools.savePreviewSetupTool(caller, input as { definition: unknown });
  return tools.stopPreviewTool(caller, input as { id: string });
}

/** 0013 Phase 6: read-only look at another chat, run, or stage visit. */
export async function inspectStep(id: string): Promise<unknown> {
  "use step";
  const { inspectTarget } = await import("../../lib/agent/tools/inspect");
  return inspectTarget(id);
}

/** 0013 Phase 6: one command in a named sandbox, without binding to it. */
export async function sandboxExecStep(
  target: string,
  command: string,
  workDir?: string,
): Promise<unknown> {
  "use step";
  const { sandboxExec } = await import("../../lib/agent/tools/inspect");
  return sandboxExec(target, command, workDir ? { workDir } : {});
}

/**
 * 0015 Part A: machine-definition tools. Every chat gets them (no
 * sandbox or project involved); the delete approval's pending row +
 * hook live in the tool execute (workflows/chat/tools.ts), same shape
 * as ask_chad.
 */
export async function machinesCatalogStep(): Promise<unknown> {
  "use step";
  const { listMachinesCatalog } = await import("../../lib/agent/tools/machines");
  return listMachinesCatalog();
}

export async function getMachineStep(id: string): Promise<unknown> {
  "use step";
  const { getMachineTool } = await import("../../lib/agent/tools/machines");
  return getMachineTool(id);
}

/** Validate a would-be machine and summarize it for Chad's approval. */
export async function createMachinePreviewStep(input: {
  id?: string;
  name: string;
  definition: unknown;
}): Promise<unknown> {
  "use step";
  const { previewCreateMachine } = await import("../../lib/agent/tools/machines");
  return previewCreateMachine(input);
}

export async function createMachineStep(input: {
  id?: string;
  name: string;
  description?: string;
  definition: unknown;
}): Promise<unknown> {
  "use step";
  const { createMachineTool } = await import("../../lib/agent/tools/machines");
  return createMachineTool(input);
}

export async function editMachineStep(input: {
  id: string;
  baseVersion: number;
  ops: import("../../lib/machines/edit").EditOp[];
  name?: string;
  description?: string;
}): Promise<unknown> {
  "use step";
  const { editMachineTool } = await import("../../lib/agent/tools/machines");
  return editMachineTool(input);
}

/** The preview for the delete approval question (name, stages, version). */
export async function machineDeletePreviewStep(id: string): Promise<unknown> {
  "use step";
  const { machineDeletePreview } = await import("../../lib/agent/tools/machines");
  return machineDeletePreview(id);
}

export async function deleteMachineStep(id: string): Promise<unknown> {
  "use step";
  const { deleteMachineTool } = await import("../../lib/agent/tools/machines");
  return deleteMachineTool(id);
}

/** 0010 Phase 4: record a pending human-input request (the ask_chad
 *  tool calls this before awaiting its hook — workflow context cannot
 *  touch sqlite, and the inbox needs the row before the answer). */
export async function pendingStep(
  conversationId: string,
  id: string,
  question: string,
  kind: "approval" | "question" = "approval",
): Promise<void> {
  "use step";
  const { db, chat } = await chatStore();
  chat.recordPendingInput(db, { id, conversationId, kind, question });
}

/** 0010 Phase 4: generated titles (0007) for new-runtime conversations —
 *  fired from the turn (the mirror hook fired for eve's). */
/**
 * 0021: resolve and validate the chat turn's route (conversation >
 * project > global) — a step because it reads sqlite and env. A route
 * the project forbids, or a provider without a key, fails the turn with
 * the reason (value-shaped issues joined) instead of a mid-stream 401.
 */
export async function resolveTurnRouteStep(
  conversationId: string,
): Promise<{ route: import("../../lib/providers/route").ChatRoute; layer: import("../../lib/providers/route").RouteLayer }> {
  "use step";
  const [{ db }, { getConversation }, { requireRoute }] = await Promise.all([
    import("../../db"),
    import("../../db/chat"),
    import("../../lib/providers/resolve"),
  ]);
  const conversation = getConversation(db(), conversationId);
  return requireRoute(db(), "chat", { conversation: conversation?.route ?? null }, conversation?.projectId);
}

export async function maybeTitleStep(conversationId: string): Promise<void> {
  "use step";
  const { maybeGenerateTitle } = await import("../../lib/titles");
  await maybeGenerateTitle(conversationId);
}

/**
 * Persist the turn's new messages (result.messages tail — includes
 * mid-turn steer injections) and clear the conversation's active run.
 * Exactly one turn runs per conversation at a time (route-enforced), so
 * an unconditional clear-if-set cannot clobber another turn.
 */
export async function persistTurn(
  conversationId: string,
  messages: ModelMessage[],
  skip: number,
  /** 0021: recorded on the turn's first assistant row ("what actually ran"). */
  route?: import("../../db/chat").MessageRowMetadata["route"],
): Promise<number> {
  "use step";
  const { db, chat } = await chatStore();
  const tail: import("../../db/chat").NewMessageRow[] = [];
  messages.slice(skip).forEach((message, i) => {
    // System messages are injected viewing notes (and the agent's
    // instructions) — model input only, never persisted as rows.
    if (message.role === "system") return;
    tail.push({
      id: `m_${conversationId}_${skip + i}_${Math.random().toString(36).slice(2, 8)}`,
      role: message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : "user",
      text: textOf(message),
      modelMessage: message,
    });
  });
  const firstAssistant = tail.find((row) => row.role === "assistant");
  if (route && firstAssistant) firstAssistant.metadata = { route };
  chat.appendMessages(db, conversationId, tail);
  chat.setActiveRun(db, conversationId, null);
  return tail.length;
}

/** Best-effort plain-text extraction for the searchable `text` column. */
function textOf(message: ModelMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "tool-call") return `[tool ${part.toolName}]`;
      if (part.type === "tool-result")
        return typeof part.output === "string"
          ? part.output
          : JSON.stringify(part.output);
      return "";
    })
    .join("")
    .trim();
}
