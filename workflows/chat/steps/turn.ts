/**
 * Turn lifecycle: history load/persist, steer, skills, route, titles, usage. Split from the old single steps.ts - every function
 * keeps its "use step" directive; Node/sqlite imports stay lazy inside
 * each step body, and relative imports stay relative (the workflow
 * bundle has no "@/" alias).
 */

import { chatStore } from "../deps";
import { renderOwnerPlaceholders } from "../../../lib/agent/owner";
import type { ModelMessage, UserContent } from "ai";

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
 * context rides as row metadata (the note is rebuilt from it each turn);
 * 0055: so does the turn's thread-state (mode + phase), same treatment.
 * These are independent facts about the same row, so they merge into
 * ONE metadata object — a second `{ metadata: {...} }` spread would
 * silently clobber the first instead of adding to it.
 */
export async function recordUserMessage(
  conversationId: string,
  text: string,
  seq: number,
  viewing?: import("../../../lib/page-context").ViewingContext,
  runEvent?: import("../../../db/chat").RunEventMeta,
  /** 0042: uploaded image ids riding this send. */
  attachmentIds?: string[],
  /** 0055: the mode/phase this turn ran in, when moded. */
  threadState?: import("../../../db/chat").MessageRowMetadata["threadState"],
): Promise<UserContent> {
  "use step";
  const { db, chat } = await chatStore();
  // 0042: the row stores `attachment:<id>` references (never bytes); the
  // returned content is what the turn feeds the model for this send.
  let content: UserContent = text;
  if (attachmentIds && attachmentIds.length > 0) {
    const store = await import("../../../db/attachments");
    const { attachmentRef } = await import("../../../lib/attachments");
    store.claimAttachments(db, attachmentIds, conversationId);
    const rows = store.getAttachments(db, attachmentIds);
    const byId = new Map(rows.map((r) => [r.id, r]));
    content = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...attachmentIds.flatMap((id) => {
        const row = byId.get(id);
        return row ? [{ type: "file" as const, data: attachmentRef(id), mediaType: row.mediaType }] : [];
      }),
    ];
  }
  const metadata: import("../../../db/chat").MessageRowMetadata = {};
  if (viewing) metadata.viewing = viewing;
  if (runEvent) metadata.runEvent = runEvent;
  if (threadState) metadata.threadState = threadState;
  chat.appendMessages(db, conversationId, [
    {
      id: `t_${conversationId}_${seq}`,
      role: "user",
      text,
      modelMessage: { role: "user", content },
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  ]);
  return content;
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

/** 0039: the thread's skill (null = plain chat). 0055: `modePhase` rides
 *  along — it is a property of the CONVERSATION, not the skill, but
 *  every caller needs them together (buildInstructions's mode-skip
 *  check, the [thread state] note) and null skill always means null
 *  phase anyway (a mode is only ever entered together with its skill). */
export async function loadSkillStep(
  conversationId: string,
): Promise<{ id: string; title: string; body: string; mode: boolean; modePhase: string | null } | null> {
  "use step";
  const [{ db, chat }, { readSkill }] = await Promise.all([chatStore(), import("../../../lib/skills")]);
  const conversation = chat.getConversation(db, conversationId);
  const id = conversation?.skill;
  const skill = id ? await readSkill(id) : null;
  return skill
    ? { id: skill.id, title: skill.title, body: skill.body, mode: skill.mode, modePhase: conversation?.modePhase ?? null }
    : null;
}

/** 0039: list thread skills, or bind one to the thread and return its
 *  body (followed from this turn on; later turns get it as instructions). */
export async function bindSkillStep(conversationId: string, id?: string): Promise<unknown> {
  "use step";
  const [{ db, chat }, { listThreadSkills }] = await Promise.all([chatStore(), import("../../../lib/skills")]);
  const available = await listThreadSkills();
  const catalog = available.map((s) => ({ id: s.id, title: s.title, description: s.description, mode: s.mode }));
  if (!id) return { ok: true, skills: catalog };
  // readSkill deliberately resolves disabled/deleted skills for existing
  // bindings; a NEW binding must use the active thread-only catalog.
  const skill = available.find((s) => s.id === id);
  if (!skill)
    return { ok: false, code: "unknown-skill", message: `No thread skill "${id}".`, skills: catalog };
  chat.setConversationSkill(db, conversationId, skill.id);
  return { ok: true, id: skill.id, note: "Bound to this thread — follow it from now on.", skill: renderOwnerPlaceholders(skill.body) };
}

/** 0054: the three editable instruction sections, resolved to their
 *  current (possibly Settings-edited) bodies — seeded from git on
 *  first touch. Shaped to drop straight into buildInstructions's
 *  `sections` input. */
export async function loadPromptSectionsStep(): Promise<{ base: string; harnessSteering: string; hostRouting: string }> {
  "use step";
  const [{ db }, store] = await Promise.all([import("../../../db"), import("../../../db/prompt-settings")]);
  const conn = db();
  const body = (key: "base" | "harness_steering" | "host_routing") => store.getTarget(conn, { kind: "section", key })!.body;
  return { base: body("base"), harnessSteering: body("harness_steering"), hostRouting: body("host_routing") };
}

/**
 * Repo AGENTS.md for the top-level agent's instructions appendix — only
 * when the conversation has a project AND its sandbox is already BOUND
 * (never provisions one just to read these files; a pending/none binding
 * or a missing file adds nothing, never an error). Thin wrapper: the
 * logic is lib/agent/tools/repo-docs.ts's loadRepoDocs (a plain function
 * so it is unit-testable against a fake provider).
 */
export async function loadRepoDocsStep(
  conversationId: string,
): Promise<import("../../../lib/agent/repo-docs").RepoDoc[]> {
  "use step";
  const { loadRepoDocs } = await import("../../../lib/agent/tools/repo-docs");
  return loadRepoDocs(conversationId);
}

/** 0037/0039: continue a thread-skill turn that hit its step budget. */
export async function continueAfterBudgetStep(conversationId: string): Promise<string> {
  "use step";
  const { continueAfterBudget } = await import("../../../lib/chat/budget");
  return continueAfterBudget(conversationId);
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
): Promise<{ route: import("../../../lib/providers/route").ChatRoute; layer: import("../../../lib/providers/route").RouteLayer }> {
  "use step";
  const [{ db }, { getConversation }, { requireRoute }] = await Promise.all([
    import("../../../db"),
    import("../../../db/chat"),
    import("../../../lib/providers/resolve"),
  ]);
  const conversation = getConversation(db(), conversationId);
  return requireRoute(db(), "chat", { conversation: conversation?.route ?? null }, conversation?.projectId);
}

export async function maybeTitleStep(conversationId: string): Promise<void> {
  "use step";
  const { maybeGenerateTitle } = await import("../../../lib/titles");
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
  route?: import("../../../db/chat").MessageRowMetadata["route"],
  opts: { from?: number; final?: boolean; exhausted?: boolean } = {},
): Promise<number> {
  "use step";
  const { db, chat } = await chatStore();
  const from = Math.max(opts.from ?? skip, skip);
  const firstAssistant = messages.findIndex((m, i) => i >= skip && m.role === "assistant");
  // 0040 phase 3: the LAST assistant row of the turn so far — tagged
  // `exhausted` only when this slice is the one that hit the step
  // budget (turn.ts passes opts.exhausted for that slice only). Found
  // the same way firstAssistant is, just from the other end.
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if (i >= skip && m.role === "assistant") lastAssistant = i;
  });
  const tail: import("../../../db/chat").NewMessageRow[] = [];
  messages.forEach((message, i) => {
    // System messages are injected viewing notes (and the agent's
    // instructions) — model input only, never persisted as rows.
    if (i < from || message.role === "system") return;
    const metadata: import("../../../db/chat").MessageRowMetadata = {};
    if (route && i === firstAssistant) metadata.route = route;
    if (opts.exhausted && i === lastAssistant) metadata.exhausted = true;
    tail.push({
      id: `m_${conversationId}_${skip}_${i - skip}`,
      role: message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : "user",
      text: textOf(message),
      modelMessage: message,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
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

/**
 * 0042: swap `attachment:<id>` file parts for image bytes. A step so the
 * fs-using resolver stays out of the workflow bundle; the model wrapper
 * calls it from inside doStream, which is already a step body, so it runs
 * inline and the bytes never reach recorded workflow state.
 */
export async function resolveAttachmentPartsStep(
  prompt: import("@ai-sdk/provider").LanguageModelV4CallOptions["prompt"],
  specificationVersion: "v3" | "v4",
): Promise<import("@ai-sdk/provider").LanguageModelV4CallOptions["prompt"]> {
  "use step";
  const { resolveAttachmentParts } = await import("../../../lib/chat/attachment-parts");
  return resolveAttachmentParts(prompt, specificationVersion);
}

/**
 * 0047: one usage_events row for a chat turn (`u_<conv>_<skip>`). Cost
 * is computed now, against the current price row — null when this
 * provider/model has none (GLM plan, unknown id). A retried step
 * re-inserts the same id; the store ignores the conflict.
 */
export async function recordUsageStep(
  conversationId: string,
  skip: number,
  route: import("../../../lib/providers/route").ChatRoute,
  usage: import("../../../lib/usage/pricing").UsageCounts,
  steps: number,
  toolCalls: number,
  startedAt: number,
  /** 0051: the turn's last slice's counts (the context meter's source). */
  lastSlice: import("../../../lib/usage/pricing").UsageCounts | null,
): Promise<void> {
  "use step";
  const [{ db }, { getPrice, recordUsageEvent }, { computeCost }] = await Promise.all([
    import("../../../db"),
    import("../../../db/usage"),
    import("../../../lib/usage/pricing"),
  ]);
  const price = getPrice(db(), route.provider, route.model);
  const now = Date.now();
  recordUsageEvent(db(), {
    id: `u_${conversationId}_${skip}`,
    conversationId,
    source: "chat",
    harnessCallId: null,
    route: JSON.stringify(route),
    inputTokens: usage.inputTokens,
    cachedTokens: usage.cachedTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens ?? 0,
    lastInputTokens: lastSlice?.inputTokens ?? null,
    lastCachedTokens: lastSlice?.cachedTokens ?? null,
    lastOutputTokens: lastSlice?.outputTokens ?? null,
    lastReasoningTokens: lastSlice?.reasoningTokens ?? null,
    steps,
    toolCalls,
    costUsd: price ? computeCost(price, usage) : null,
    startedAt,
    endedAt: now,
    createdAt: now,
  });
}
