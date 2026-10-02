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

export function rowsToUIMessages(rows: StoredRow[]): UIMessage[] {
  const out: UIMessage[] = [];
  const toolParts = new Map<string, ToolPart>();
  let current: UIMessage | null = null; // the open assistant message

  const meta = (row: StoredRow) => ({
    at: new Date(row.at).toISOString(),
    ...(row.metadata?.viewing ? { viewing: row.metadata.viewing } : {}),
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
      out.push({
        id: row.id,
        role: "user",
        parts: [{ type: "text", text }],
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
