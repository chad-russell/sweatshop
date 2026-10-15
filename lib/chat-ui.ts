import { parseAttachmentRef } from "@/lib/attachment-ref";
import type { ModelMessage, UIMessage } from "ai";
import type { MessageRowMetadata } from "@/db/chat";

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

export function rowsToUIMessages(rows: StoredRow[]): UIMessage[] {
  const out: UIMessage[] = [];
  const toolParts = new Map<string, ToolPart>();
  let current: UIMessage | null = null; // the open assistant message

  const meta = (row: StoredRow) => ({
    at: new Date(row.at).toISOString(),
    ...(row.metadata?.viewing ? { viewing: row.metadata.viewing } : {}),
    // 0022: a wake row's chip ("[pi finished]" is not Chad's words).
    ...(row.metadata?.runEvent ? { runEvent: row.metadata.runEvent } : {}),
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
const BACKGROUND_TOOLS = new Set(["start_machine", "pi", "claude", "cursor", "start_thread"]);

/** Whether the transcript shows background work that has not yet woken
 *  it: a started child (run or harness handle) after the latest wake. A
 *  wake for an earlier child is fine — this only gates a cheap poll. */
export function hasBackgroundChild(messages: UIMessage[]): boolean {
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
