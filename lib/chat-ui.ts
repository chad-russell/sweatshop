import { parseAttachmentRef } from "@/lib/attachment-ref";
import type { ModelMessage, UIMessage } from "ai";
import type { MessageRowMetadata } from "@/db/chat";
import { phaseFromMessages, type Phase } from "@/lib/thread-phase";
import { workPRsFromMessages, type WorkPR } from "@/lib/work-prs";
import { deriveOutlineTrayContext, type OutlineTrayContext } from "@/lib/outline";

/**
 * Rebuild the UI transcript from persisted rows (reload / initial render).
 *
 * The live stream renders a whole turn as ONE assistant UIMessage whose
 * parts are text and tool parts; the store keeps the turn as several
 * ModelMessages (assistant → tool → assistant …). This folds them back
 * into the live shape so a reload looks like what streamed, instead of
 * showing the flattened `messages.text` column (`[tool pi]` + raw JSON).
 */
export interface StoredRow {
  id: string;
  role: string;
  text: string;
  at: number;
  modelMessage: ModelMessage | null;
  /** 0015: row metadata — the user message's viewing context (chip). */
  metadata?: MessageRowMetadata | null;
}

type ToolPart = {
  type: `tool-${string}`;
  toolCallId: string;
  state: "input-available" | "output-available" | "output-error";
  input: unknown;
  output?: unknown;
  errorText?: string;
};

/** Tool results carry an AI SDK output envelope; unwrap it for display. */
function unwrapOutput(output: unknown): { output?: unknown; errorText?: string } {
  if (output && typeof output === "object" && "type" in output) {
    const { type, value } = output as { type: unknown; value?: unknown };
    if (type === "error-text") return { errorText: String(value) };
    if (type === "error-json") return { errorText: JSON.stringify(value) };
    if (type === "execution-denied") {
      const reason = (output as { reason?: unknown }).reason;
      return { errorText: typeof reason === "string" ? reason : "Denied" };
    }
    if (type === "text" || type === "json" || type === "content") return { output: value };
  }
  return { output };
}

/**
 * 0037: rows up to and including the live turn's opening message. A
 * running turn persists slice by slice, but a reload replays its whole
 * stream, so its persisted slices must not also render from rows. Every
 * turn opens with the row recordUserMessage writes (`t_<conv>_<seq>`);
 * mid-turn steers and slices use other ids, so the cut is exact.
 */
export function untilLiveTurn(rows: StoredRow[]): StoredRow[] {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.id.startsWith("t_")) return rows.slice(0, i + 1);
  }
  return rows;
}

/**
 * 0075 fixup: the aligned head of a page that could NOT be walked back
 * to a turn opener (a transient fetch failure on a client path): rows
 * before the page's oldest `t_` row are a partial turn — drop them;
 * they stay reachable below the page's older cursor. A page holding no
 * `t_` row at all is one fold the walk never escaped: return null so
 * the caller can decline to render (or prepend) any of it — a partial
 * fold splits its turn the moment an aligned page joins it.
 */
export function alignPageHead(rows: StoredRow[]): StoredRow[] | null {
  const first = rows.findIndex((row) => row.id.startsWith("t_"));
  if (first === -1) return null;
  return first === 0 ? rows : rows.slice(first);
}

export function rowsToUIMessages(rows: StoredRow[]): UIMessage[] {  const out: UIMessage[] = [];
  const toolParts = new Map<string, ToolPart>();
  let current: UIMessage | null = null; // the open assistant message

  const meta = (row: StoredRow) => ({
    at: new Date(row.at).toISOString(),
    ...(row.metadata?.viewing ? { viewing: row.metadata.viewing } : {}),
    // 0022: a wake row's chip ("[pi finished]" is not Chad's words).
    ...(row.metadata?.runEvent ? { runEvent: row.metadata.runEvent } : {}),
    // 0091 §3: the send's attached skills (chips, like viewing).
    ...(row.metadata?.attachedSkills ? { attachedSkills: row.metadata.attachedSkills } : {}),
  });

  for (const row of rows) {
    const message = row.modelMessage;
    if (!message) {
      // Pre-0010 mirror rows: text only.
      current = null;
      out.push({
        id: row.id,
        role: row.role === "assistant" ? "assistant" : "user",
        parts: [{ type: "text", text: row.text }],
        metadata: meta(row),
      });
      continue;
    }

    if (message.role === "user" || message.role === "system") {
      current = null;
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("");
      // 0042: stored `attachment:<id>` image parts come back as UI file
      // parts pointing at the serving route (shown above the text).
      const images =
        typeof message.content === "string"
          ? []
          : message.content.flatMap((part) => {
              if (part.type !== "file" || typeof part.data !== "string") return [];
              const id = parseAttachmentRef(part.data);
              return id
                ? [{ type: "file" as const, mediaType: part.mediaType, url: `/api/attachments/${id}` }]
                : [];
            });
      out.push({
        id: row.id,
        role: "user",
        parts: [...images, ...(text || images.length === 0 ? [{ type: "text" as const, text }] : [])],
        metadata: meta(row),
      });
      continue;
    }

    if (message.role === "assistant") {
      if (!current) {
        current = { id: row.id, role: "assistant", parts: [], metadata: meta(row) };
        out.push(current);
      }
      if (typeof message.content === "string") {
        if (message.content) current.parts.push({ type: "text", text: message.content });
        continue;
      }
      for (const part of message.content) {
        if (part.type === "text") {
          if (part.text) current.parts.push({ type: "text", text: part.text });
        } else if (part.type === "tool-call") {
          const toolPart: ToolPart = {
            type: `tool-${part.toolName}`,
            toolCallId: part.toolCallId,
            state: "input-available",
            input: part.input,
          };
          toolParts.set(part.toolCallId, toolPart);
          current.parts.push(toolPart as unknown as UIMessage["parts"][number]);
        }
      }
      continue;
    }

    // role === "tool": settle the matching tool parts of the open message.
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const target = toolParts.get(part.toolCallId);
        if (!target) continue;
        const { output, errorText } = unwrapOutput(part.output);
        if (errorText !== undefined) {
          target.state = "output-error";
          target.errorText = errorText;
        } else {
          target.state = "output-available";
          target.output = output;
        }
      }
    }
  }
  return out;
}

/** Tools whose successful result is a background child that will wake
 *  this chat when it settles (0022; start_thread children, 0037). */
const BACKGROUND_TOOLS = new Set(["start_machine", "pi", "claude", "cursor", "codex", "start_thread"]);

/** Whether the transcript shows background work that has not yet woken
 *  it: a started child (run or harness handle) after the latest wake. A
 *  wake for an earlier child is fine — this only gates a cheap poll. */
export function hasBackgroundChild(messages: readonly UIMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && (m.metadata as { runEvent?: unknown } | undefined)?.runEvent) return false;
    for (const p of m.parts) {
      if (!p.type.startsWith("tool-") || !BACKGROUND_TOOLS.has(p.type.slice(5))) continue;
      const part = p as { state?: string; output?: unknown };
      const out = part.state === "output-available" ? (part.output as { runId?: unknown; callId?: unknown } | undefined) : undefined;
      if (typeof out?.runId === "string" || typeof out?.callId === "string") return true;
    }
  }
  return false;
}

/** Harness tools whose successful result carries the started call's id
 *  as `callId` (`StartHarnessCallResult`). `start_thread`'s own result
 *  carries it as `id` instead (`StartThreadResult`). */
const HARNESS_TOOLS = new Set(["pi", "claude", "cursor", "codex"]);

/** 0055 PR2: every background child (harness call or start_thread
 *  child) this transcript has ever started, in first-seen order — the
 *  Mode chip's "Working now" set polls each via useChildStatus (no new
 *  polling mechanism; just discovering what's already there to poll). */
export function backgroundChildIds(messages: UIMessage[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (!p.type.startsWith("tool-")) continue;
      const name = p.type.slice(5);
      if (!HARNESS_TOOLS.has(name) && name !== "start_thread") continue;
      const part = p as { state?: string; output?: unknown };
      if (part.state !== "output-available") continue;
      const out = part.output as { callId?: unknown; id?: unknown } | undefined;
      const id = typeof out?.callId === "string" ? out.callId : typeof out?.id === "string" ? out.id : null;
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

/** 0055 PR2 review fix: `backgroundChildIds` minus any child that has
 *  already woken this chat — a wake row is a `user` message whose
 *  `metadata.runEvent` names the settled child by id (kind "harness" =
 *  a harness call, "thread" = a start_thread child; same fields
 *  `hasBackgroundChild` reasons from). Keeps the work chip from polling
 *  a child forever just because the transcript still shows its tool
 *  call — once it has settled and woken the chat, there is nothing
 *  left to watch. */
export function liveBackgroundChildIds(messages: UIMessage[]): string[] {
  const woken = new Set<string>();
  for (const m of messages) {
    if (m.role !== "user") continue;
    const runEvent = (m.metadata as { runEvent?: { kind?: string; id?: string } } | undefined)?.runEvent;
    if (runEvent && (runEvent.kind === "harness" || runEvent.kind === "thread") && typeof runEvent.id === "string") {
      woken.add(runEvent.id);
    }
  }
  return backgroundChildIds(messages).filter((id) => !woken.has(id));
}

// ── Lazy transcript window (0075) ──────────────────────────────────────
// Pages of rows fold in isolation; these pure merges knit a window and a
// fetched page back into one transcript without duplicates. Fold ids are
// the first row id of each fold (user rows always open a fold), so id
// equality is row-level alignment.

/** Prepend older messages (a page fetched backwards) to the current
 *  window, dropping any the window already shows. Pure — returns a new
 *  array, oldest-first, never mutating its inputs. */
export function mergeOlder(current: readonly UIMessage[], older: readonly UIMessage[]): UIMessage[] {
  if (older.length === 0) return [...current];
  const known = new Set(current.map((m) => m.id));
  return [...older.filter((m) => !known.has(m.id)), ...current];
}

/**
 * Append newer messages (a tail page fetched for a wake) to the current
 * window. The page may start anywhere — mid-fold, even — so append is
 * gated: when the page's first message is one the window already has,
 * alignment is exact and only unknown messages append. Otherwise the
 * window is stale past recognition and the only safe append point is a
 * turn boundary this window has never seen (`t_…` id, always a fold
 * opener — a partial older fold would duplicate text already shown);
 * with no such boundary, nothing changes. New turns always open with a
 * `t_` row, so a finished wake turn is never missed — it just may take
 * until the boundary is fully inside the page.
 */
/**
 * 0076: append newer messages (a settled wake turn) — span-safe. The
 * page may start BELOW the window head (the tail walk strides by
 * whole pages and can overshoot; review finding 1): in that case trim
 * the page to the window's head by id — rows the window already shows
 * are dropped wherever they sit — and append what is genuinely new.
 * A page whose first message is exactly known keeps the fast path.
 * With no overlap at all, fall back to the turn-boundary gate (append
 * only from an unseen `t_` opener): an unaligned page mid-fold
 * would otherwise split a fold and duplicate text.
 */
export function appendNewer(current: readonly UIMessage[], newer: readonly UIMessage[]): UIMessage[] {
  if (newer.length === 0) return [...current];
  if (current.length === 0) return [...newer];
  const known = new Set(current.map((m) => m.id));
  if (known.has(newer[0]!.id)) {
    return [...current, ...newer.filter((m) => !known.has(m.id))];
  }
  // Spanning page: it overlaps the window. Append its unknown ids only
  // when they sit strictly AFTER the window last known row (the usual
  // shape — the page ends in new rows). Unknown ids BELOW the window
  // head belong to a partial fold the window may not show; decline (a
  // no-op) and let the next poll re-page from a wider walk.
  let lastKnown = -1;
  for (let i = newer.length - 1; i >= 0; i -= 1) {
    if (known.has(newer[i]!.id)) {
      lastKnown = i;
      break;
    }
  }
  if (lastKnown !== -1) {
    const fresh = newer.slice(lastKnown + 1).filter((m) => !known.has(m.id));
    return fresh.length > 0 ? [...current, ...fresh] : [...current];
  }
  // No overlap at all. Disjoint row ids mean nothing can duplicate,
  // so a page holding an UNSEEN turn opener appends from it (the wake
  // case: the newest tail starts mid-fold of an older turn the window
  // shows under a different fold id). A page with no unseen t_ is
  // entirely older/mid-fold content — no-op (review finding 1's
  // below-window splice happens only WITH overlap, caught above).
  const firstNewTurn = newer.findIndex((m) => !known.has(m.id) && m.id.startsWith("t_"));
  return firstNewTurn === -1 ? [...current] : [...current, ...newer.slice(firstNewTurn)];
}

/**
 * The server-derived context block (`GET /api/x/chat?context=1`): the
 * header/composer chrome facts (phase chip, work PRs, the outline tray,
 * wake watch) computed over the WHOLE transcript, so a page that only
 * hydrated a tail window shows exactly what a full render would. Pure —
 * takes the folded transcript, never the db.
 */
export interface ChatContextBlock {
  phase: Phase | null;
  prs: WorkPR[];
  /** 0079: the outline tray's data — null before any update_outline. */
  outline: OutlineTrayContext | null;
  hasBackgroundChild: boolean;
}

export function deriveChatContext(messages: readonly UIMessage[]): ChatContextBlock {
  return {
    phase: phaseFromMessages(messages),
    prs: workPRsFromMessages(messages),
    outline: deriveOutlineTrayContext(messages),
    hasBackgroundChild: hasBackgroundChild(messages),
  };
}
