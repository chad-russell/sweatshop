import type { ModelMessage } from "ai";
import { chatStore } from "./deps";

/**
 * 0010 spike turn side effects — every function here is a `"use step"`
 * (replay-safe via recorded results); Node/sqlite imports happen inside
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
  /** 0037: the running turn's messages (screenshots attached this turn). */
  live: ModelMessage[] = [],
): Promise<unknown> {
  "use step";
  const { buildChatPRPreview } = await import("../../lib/agent/tools/pr-preview");
  return buildChatPRPreview(conversationId, input, undefined, live);
}

/** 0037: the thread's playbook (null = plain chat). */
export async function loadPlaybookStep(
  conversationId: string,
): Promise<{ id: string; title: string; body: string } | null> {
  "use step";
  const [{ db, chat }, { readPlaybook }] = await Promise.all([chatStore(), import("../../lib/playbooks")]);
  const id = chat.getConversation(db, conversationId)?.playbook;
  const book = id ? await readPlaybook(id) : null;
  return book ? { id: book.id, title: book.title, body: book.body } : null;
}

/** 0037: list playbooks, or bind one to the thread and return its body
 *  (followed from this turn on; later turns get it as instructions). */
export async function bindPlaybookStep(conversationId: string, id?: string): Promise<unknown> {
  "use step";
  const [{ db, chat }, { listPlaybooks, readPlaybook }] = await Promise.all([chatStore(), import("../../lib/playbooks")]);
  const list = async () => (await listPlaybooks()).map((b) => ({ id: b.id, title: b.title, description: b.description }));
  if (!id) return { ok: true, playbooks: await list() };
  const book = await readPlaybook(id);
  if (!book) return { ok: false, code: "unknown-playbook", message: `No playbook "${id}".`, playbooks: await list() };
  chat.setConversationPlaybook(db, conversationId, book.id);
  return { ok: true, id: book.id, note: "Bound to this thread — follow it from now on.", playbook: book.body };
}

/** 0037: continue a playbook turn that hit its step budget. */
export async function continueAfterBudgetStep(conversationId: string): Promise<string> {
  "use step";
  const { continueAfterBudget } = await import("../../lib/chat/budget");
  return continueAfterBudget(conversationId);
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

/** 0022: cancel a run the agent started (or watches). */
export async function cancelRunStep(runId: string): Promise<unknown> {
  "use step";
  const { cancelRunTool } = await import("../../lib/agent/tools/cancel-run");
  return cancelRunTool(runId);
}

/** 0037 phase 3: start a fresh child thread (its own context, this
 *  sandbox by default) that wakes this conversation when it settles. */
export async function startThreadStep(
  conversationId: string,
  input: { prompt: string; playbook?: string; fresh?: boolean },
): Promise<unknown> {
  "use step";
  const { startThread } = await import("../../lib/agent/tools/start-thread");
  return startThread({ conversationId, ...input });
}

/** 0037 phase 3: at a turn's end — wake this thread's parent if this
 *  thread is a settled child (no-op for every other conversation; one
 *  select). Runs after the budget decision so a continuing child reads
 *  as still-working, and a bounded one still reports. */
export async function wakeParentStep(conversationId: string): Promise<"woke" | "skipped" | "none"> {
  "use step";
  const { wakeChatChildByIdIfDue } = await import("../../lib/chat/wake");
  return wakeChatChildByIdIfDue(conversationId);
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

/** 0035: attach a sandbox PNG to the conversation. */
export async function screenshotStep(
  conversationId: string,
  input: { path: string; label?: string },
): Promise<unknown> {
  "use step";
  const tools = await import("../../lib/agent/tools/screenshot");
  return tools.attachScreenshotTool(conversationId, input);
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

/** 0010 Phase 4: record a pending human-input request (the ask_chad
 *  tool calls this before awaiting its hook — workflow context cannot
 *  touch sqlite, and the inbox needs the row before the answer). */
export async function pendingStep(
  conversationId: string,
  id: string,
  question: string,
  kind: "approval" | "question" = "approval",
  /** 0037: runtime-built evidence rendered on the card. */
  card?: unknown,
): Promise<void> {
  "use step";
  const { db, chat } = await chatStore();
  chat.recordPendingInput(db, { id, conversationId, kind, question, ...(card !== undefined ? { card } : {}) });
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
 * Persist the turn's messages from index `from` on (result.messages tail
 * — includes mid-turn steer injections). Called after EVERY slice
 * (run 5: a 30-minute turn was invisible to sqlite until it ended) and
 * once at the end with `final`, which clears the conversation's active
 * run. Row ids are deterministic per (turn, index) — the turn is keyed
 * by `skip`, which grows every turn — so a retried step never
 * duplicates a row. Exactly one turn runs per conversation at a time
 * (route-enforced), so the final clear cannot clobber another turn.
 */
export async function persistTurn(
  conversationId: string,
  messages: ModelMessage[],
  skip: number,
  /** 0021: recorded on the turn's first assistant row ("what actually ran"). */
  route?: import("../../db/chat").MessageRowMetadata["route"],
  opts: { from?: number; final?: boolean } = {},
): Promise<number> {
  "use step";
  const { db, chat } = await chatStore();
  const from = Math.max(opts.from ?? skip, skip);
  const firstAssistant = messages.findIndex((m, i) => i >= skip && m.role === "assistant");
  const tail: import("../../db/chat").NewMessageRow[] = [];
  messages.forEach((message, i) => {
    // System messages are injected viewing notes (and the agent's
    // instructions) — model input only, never persisted as rows.
    if (i < from || message.role === "system") return;
    tail.push({
      id: `m_${conversationId}_${skip}_${i - skip}`,
      role: message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : "user",
      text: textOf(message),
      modelMessage: message,
      ...(route && i === firstAssistant ? { metadata: { route } } : {}),
    });
  });
  chat.appendMessages(db, conversationId, tail);
  if (opts.final ?? true) chat.setActiveRun(db, conversationId, null);
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
