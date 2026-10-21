import type { WritableStreamDefaultWriter } from "node:stream/web";

/**
 * 0031 cut 5: the harness event sink both harness consumers share —
 * the chat pi/claude tool step (workflows/chat/harness-step.ts) and the
 * machine harness stage step (workflows/machines/harness-step.ts).
 *
 * Pure: no static Node imports (this tree compiles into workflow
 * bundles); everything substrate-shaped (recordEvent, clip) is injected
 * by the caller, which loads it dynamically inside its step. The two
 * consumers differ only in hooks:
 *   - `forward`  transforms a chunk before it is written downstream
 *                (chat: UI chunk → model stream part; may drop it);
 *   - `envelope` adds fields to every forwarded chunk
 *                (chat: chatConversation/chatHarness; runs: machineRun/machineSeq);
 *   - `onToolResult` observes successful tool results
 *                (runs: the `transition` proposal).
 */

export interface HarnessSinkArgs {
  /** Already-bound recordHarnessEvent(sessionId, kind, event). */
  recordEvent: (event: {
    kind: "start" | "end" | "tool-start" | "tool-end" | "tool-error" | "step-start" | "step-end";
    toolName?: string;
    toolCallId?: string;
    input?: string;
    output?: string;
    text?: string;
  }) => void;
  /** Already-bound clipHarnessText. */
  clip: (value: unknown, limit: number) => string | undefined;
  inputClip: number;
  outputClip: number;
  writer: WritableStreamDefaultWriter<Record<string, unknown>>;
  forward?: (chunk: Record<string, unknown>) => Record<string, unknown> | undefined;
  envelope?: Record<string, unknown>;
  onToolStart?: (toolName: string) => void;
  onToolResult?: (toolName: string, output: unknown) => void;
  /** 0047: `finish-step` carries the step's usage when the adapter
   *  includes it (LanguageModelV4Usage, nested input/output objects).
   *  The AI SDK's UI-chunk transform currently drops that field; the
   *  hook still fires whenever a usage object is present. */
  onUsage?: (usage: unknown) => void;
  /** 0062: a `finish` / `finish-step` chunk carrying harness metadata
   *  (Claude Code's cumulative cost rides there). Fires with the whole
   *  chunk; the caller extracts what it understands. */
  onFinishMetadata?: (chunk: Record<string, unknown>) => void;
}

export interface HarnessSink {
  sink: WritableStream<Record<string, unknown>>;
  /** Assistant text accumulated from text deltas so far. */
  text: () => string;
}

export function harnessEventSink(args: HarnessSinkArgs): HarnessSink {
  let text = "";
  const toolNames = new Map<string, string>();
  const sink = new WritableStream<Record<string, unknown>>({
    async write(chunk) {
      switch (chunk.type) {
        case "text-delta":
          text += String(chunk.delta ?? "");
          break;
        case "tool-input-available": {
          const name = String(chunk.toolName ?? "");
          toolNames.set(String(chunk.toolCallId), name);
          args.onToolStart?.(name);
          // fileChange / compaction are synthetic harness events, not calls.
          if (name !== "fileChange" && name !== "compaction") {
            args.recordEvent({
              kind: "tool-start",
              toolName: name,
              toolCallId: String(chunk.toolCallId),
              input: args.clip(chunk.input, args.inputClip),
            });
          }
          break;
        }
        case "tool-output-available": {
          const name = toolNames.get(String(chunk.toolCallId)) ?? "tool";
          args.recordEvent({
            kind: "tool-end",
            toolName: name,
            toolCallId: String(chunk.toolCallId),
            output: args.clip(chunk.output, args.outputClip),
          });
          args.onToolResult?.(name, chunk.output);
          break;
        }
        case "tool-output-error": {
          const name = toolNames.get(String(chunk.toolCallId)) ?? "tool";
          args.recordEvent({
            kind: "tool-error",
            toolName: name,
            toolCallId: String(chunk.toolCallId),
            output: args.clip(chunk.errorText, args.outputClip),
          });
          break;
        }
        case "finish-step":
          // Last finish-step in the write wins; the caller sums across
          // semantic steps. A chunk with no usage (the UI transform
          // strips it) does not clobber an earlier one.
          if (chunk.usage != null) args.onUsage?.(chunk.usage);
          args.onFinishMetadata?.(chunk);
          break;
        case "finish":
          args.onFinishMetadata?.(chunk);
          break;
      }
      const forwarded = args.forward ? args.forward(chunk) : chunk;
      if (forwarded !== undefined) {
        await args.writer.write({ ...forwarded, ...args.envelope });
      }
    },
  });
  return { sink, text: () => text };
}
