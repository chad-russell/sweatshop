import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db";
import { conversationGroupIds, rootConversationId } from "../../db/organize";
import { getModelInfo } from "../../db/providers";
import { conversations, harnessCalls, messages, pendingInputs } from "../../db/schema";
import { readContextUsage, sumGroupUsage, type UsageEvent } from "../../db/usage";
import { PROVIDER_LABELS, type ProviderId } from "../providers/catalog";

/**
 * 0047 read: one conversation's group (root + descendants) rolled up for
 * the stats drawer. Computed on request — groups are small and the
 * usage_events index is conversation-scoped.
 */

export interface ModelUsage {
  key: string;
  label: string;
  provider: string;
  model: string;
  isHarness: boolean;
  costUsd: number | null;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  steps: number;
  toolCalls: number;
  events: number;
}

export interface ChildUsage {
  conversationId: string;
  title: string;
  kind: "conversation" | "harness";
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  workMs: number;
  steps: number;
  href: string;
}

export interface ConversationStats {
  rootId: string;
  conversationIds: string[];
  totals: {
    costUsd: number | null;
    inputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    steps: number;
    toolCalls: number;
    workMs: number;
  };
  wallMs: number | null;
  waitMs: number;
  /** Median answered pending-input latency. The time strip shows it. */
  medianWaitMs: number | null;
  touches: number;
  byModel: ModelUsage[];
  byChild: ChildUsage[];
  cacheHitRate: number | null;
  /** 0051: THIS conversation's context (not the group's) — the last
   * metered slice's input+output against the model's window. Null when
   * the chat has no metered turns or the model's window is unknown. */
  context: ContextStats | null;
}

export interface ContextStats {
  usedTokens: number;
  windowTokens: number;
  /** 0..1, clamped at the top; unrounded — the UI rounds for display. */
  pct: number;
}

function isProvider(id: string): id is ProviderId {
  return id === "glm" || id === "gloo" || id === "openrouter";
}

function routeBits(raw: string): { key: string; provider: string; model: string; isHarness: boolean } {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object") parsed = value as Record<string, unknown>;
  } catch {
    /* a corrupt route still counts, under "unknown" */
  }
  const harness = typeof parsed.harness === "string" ? parsed.harness : "";
  if (harness === "claude" || harness === "cursor" || harness === "codex") {
    return {
      key: harness,
      provider: harness,
      model: typeof parsed.model === "string" ? parsed.model : "",
      isHarness: true,
    };
  }
  const provider = typeof parsed.provider === "string" && parsed.provider ? parsed.provider : "unknown";
  const model = typeof parsed.model === "string" && parsed.model ? parsed.model : "unknown";
  return { key: `${provider}/${model}`, provider, model, isHarness: false };
}

function modelLabel(db: Db, provider: string, model: string, isHarness: boolean): string {
  if (isHarness && provider === "claude") return "Claude";
  if (isHarness && provider === "cursor") return "Cursor";
  if (isHarness && provider === "codex") return "Codex";
  if (isProvider(provider)) {
    const info = getModelInfo(db, provider, model);
    if (info) return `${PROVIDER_LABELS[provider]} ${info.label}`;
  }
  return model || provider;
}

function sumCost(events: UsageEvent[]): number | null {
  let cost: number | null = null;
  for (const event of events) {
    if (event.costUsd !== null) cost = (cost ?? 0) + event.costUsd;
  }
  return cost;
}

function modelsOf(db: Db, events: UsageEvent[]): ModelUsage[] {
  const order: string[] = [];
  const buckets = new Map<string, ModelUsage>();
  for (const event of events) {
    const bits = routeBits(event.route);
    let row = buckets.get(bits.key);
    if (!row) {
      row = {
        key: bits.key,
        label: modelLabel(db, bits.provider, bits.model, bits.isHarness),
        provider: bits.provider,
        model: bits.model,
        isHarness: bits.isHarness,
        costUsd: null,
        inputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        steps: 0,
        toolCalls: 0,
        events: 0,
      };
      buckets.set(bits.key, row);
      order.push(bits.key);
    }
    row.inputTokens += event.inputTokens;
    row.cachedTokens += event.cachedTokens;
    row.cacheWriteTokens += event.cacheWriteTokens;
    row.outputTokens += event.outputTokens;
    row.steps += event.steps;
    row.toolCalls += event.toolCalls;
    row.events += 1;
    if (event.costUsd !== null) row.costUsd = (row.costUsd ?? 0) + event.costUsd;
  }
  return order.map((key) => buckets.get(key)!);
}

function clipTitle(text: string | null, fallback: string): string {
  const line = (text ?? "").split("\n")[0]?.trim() ?? "";
  if (!line) return fallback;
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  return sorted[mid]!;
}

export function readConversationStats(db: Db, conversationId: string, now = Date.now()): ConversationStats {
  const rootId = rootConversationId(db, conversationId);
  const ids = conversationGroupIds(db, rootId);
  const group = sumGroupUsage(db, ids);

  const convs = db
    .select({
      id: conversations.id,
      title: conversations.title,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(inArray(conversations.id, ids))
    .all();
  const byId = new Map(convs.map((row) => [row.id, row]));
  const root = byId.get(rootId);
  const wallMs =
    root && convs.length > 0 ? Math.max(0, Math.max(...convs.map((row) => row.updatedAt)) - root.createdAt) : null;

  const userRows =
    ids.length === 0
      ? []
      : db
          .select({ metadata: messages.metadata })
          .from(messages)
          .where(and(inArray(messages.conversationId, ids), eq(messages.role, "user")))
          .all();
  let touches = 0;
  for (const row of userRows) {
    if (!row.metadata) {
      touches += 1;
      continue;
    }
    try {
      const meta = JSON.parse(row.metadata) as { runEvent?: unknown };
      if (meta && typeof meta === "object" && meta.runEvent) continue;
    } catch {
      /* a bad blob is still a person, not a wake chip */
    }
    touches += 1;
  }

  const pending =
    ids.length === 0
      ? []
      : db
          .select({ createdAt: pendingInputs.createdAt, resolvedAt: pendingInputs.resolvedAt })
          .from(pendingInputs)
          .where(inArray(pendingInputs.conversationId, ids))
          .all();
  const waits: number[] = [];
  for (const row of pending) {
    if (row.resolvedAt == null) continue;
    waits.push(Math.max(0, row.resolvedAt - row.createdAt));
  }

  const calls =
    ids.length === 0
      ? []
      : db
          .select()
          .from(harnessCalls)
          .where(inArray(harnessCalls.conversationId, ids))
          .all()
          .sort((a, b) => a.createdAt - b.createdAt);

  const byChild: ChildUsage[] = ids.map((id) => {
    const chat = group.events.filter((event) => event.conversationId === id && event.source === "chat");
    return {
      conversationId: id,
      title: clipTitle(byId.get(id)?.title ?? null, "Untitled"),
      kind: "conversation",
      costUsd: sumCost(chat),
      inputTokens: chat.reduce((n, event) => n + event.inputTokens, 0),
      outputTokens: chat.reduce((n, event) => n + event.outputTokens, 0),
      workMs: chat.reduce((n, event) => n + Math.max(0, event.endedAt - event.startedAt), 0),
      steps: chat.reduce((n, event) => n + event.steps, 0),
      href: `/c/${id}`,
    };
  });
  for (const call of calls) {
    const harness = group.events.filter((event) => event.source === "harness" && event.harnessCallId === call.id);
    byChild.push({
      conversationId: call.conversationId,
      title: clipTitle(call.task, "Harness call"),
      kind: "harness",
      costUsd: sumCost(harness),
      inputTokens: harness.reduce((n, event) => n + event.inputTokens, 0),
      outputTokens: harness.reduce((n, event) => n + event.outputTokens, 0),
      workMs:
        call.settledAt != null ? Math.max(0, call.settledAt - call.createdAt) : Math.max(0, now - call.createdAt),
      steps: harness.reduce((n, event) => n + event.steps, 0),
      href: `/h/${call.kind}/${call.conversationId}/${call.id}`,
    });
  }

  // 0051: the context meter reads THIS conversation's own latest
  // metered chat row — never the group's (each chat feeds its own model).
  const ctxRow = readContextUsage(db, conversationId);
  let context: ContextStats | null = null;
  if (ctxRow) {
    const bits = routeBits(ctxRow.route);
    if (!bits.isHarness && isProvider(bits.provider)) {
      const info = getModelInfo(db, bits.provider, bits.model);
      if (info) {
        const used = ctxRow.inputTokens + ctxRow.outputTokens;
        if (used > 0 && info.contextWindow > 0) {
          context = {
            usedTokens: used,
            windowTokens: info.contextWindow,
            pct: Math.min(1, used / info.contextWindow),
          };
        }
      }
    }
  }

  return {
    rootId,
    conversationIds: ids,
    totals: {
      costUsd: group.totalCostUsd,
      inputTokens: group.inputTokens,
      cachedTokens: group.cachedTokens,
      cacheWriteTokens: group.cacheWriteTokens,
      outputTokens: group.outputTokens,
      reasoningTokens: group.reasoningTokens,
      steps: group.steps,
      toolCalls: group.toolCalls,
      workMs: group.workMs,
    },
    wallMs,
    waitMs: waits.reduce((n, value) => n + value, 0),
    medianWaitMs: median(waits),
    touches,
    byModel: modelsOf(db, group.events),
    byChild,
    cacheHitRate: group.inputTokens > 0 ? group.cachedTokens / group.inputTokens : null,
    context,
  };
}
