import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

/**
 * 0010 spike mock LLM — the repo's first agent-behavior mock (AGENTS.md:
 * tests never wait on a real model call). Selected by the turn workflow
 * when SWEATSHOP_CHAT_MOCK names a script and NODE_ENV=test, so it can
 * never fire in dev or production.
 *
 * Every script is STATELESS — keyed on prompt shape, not a call counter:
 * the workflow serializes the model across step boundaries, so instance
 * state resets between slices. (Real models are stateless the same way.)
 * SWEATSHOP_CHAT_MOCK ("plain" | "approve" | "question" |
 * "structured-question" | "steer" | "hang" | "create-pr" | "viewing" |
 * "thread-state" | "skill" | "loop" | "accept-plan" | "outline-propose" |
 * "enter-mode" | "cache") is read at call time so a test file can switch
 * scripts between turns.
 *
 * The "steer" script never touches the database itself: workflow context
 * (where doStream runs) forbids Node APIs. The TEST enqueues the steer
 * row before starting the turn; slice 1's tool call forces a second
 * slice, and the drain between slices must inject the row first.
 */

/** Realistic V4 usage so a mock turn writes a non-zero usage_events row.
 *  cacheRead is 0 (cachedTokens = cache READ only). */
const NO_USAGE = {
  inputTokens: {
    total: 100,
    noCache: 100,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: { total: 50, text: 40, reasoning: 10 },
};

function textPart(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: NO_USAGE },
  ];
}

function toolCallPart(
  toolCallId: string,
  toolName: string,
  input: unknown,
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "ti", toolName },
    { type: "tool-input-end", id: "ti" },
    {
      type: "tool-call",
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: NO_USAGE },
  ];
}

function result(parts: LanguageModelV4StreamPart[]) {
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

type PromptMessage = LanguageModelV4CallOptions["prompt"][number];

function messageText(message: PromptMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** Stable per-conversation ask id: a short hash of the send texts. Two
 *  conversations never share it, so pending_inputs' conflict-do-nothing
 *  insert can never silently swallow one test's card for another's. */
function askCallId(sends: string[]): string {
  let h = 0;
  for (const t of sends) for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return `call_ask_${(h >>> 0).toString(36)}`;
}

function userTexts(prompt: LanguageModelV4CallOptions["prompt"]): string[] {
  return prompt
    .filter((message) => message.role === "user")
    .map(messageText);
}

export function scriptedChatModel(): LanguageModel {
  return new MockLanguageModelV4({
    provider: "sweatshop-mock",
    modelId: "mock-chat",
    doStream: async (options) => {
      const script = process.env.SWEATSHOP_CHAT_MOCK ?? "plain";
      // Script position derives from the prompt (stateless): a tool
      // message present means this is the slice after a tool round-trip.
      const sawToolResult = options.prompt.some((m) => m.role === "tool");

      if (script === "hang") {
        await new Promise<never>(() => {});
      }

      if (script === "cache") {
        return result(textPart("cache metering").map((part) => part.type === "finish" ? {
          ...part,
          usage: { ...NO_USAGE, inputTokens: { total: 100, noCache: 20, cacheRead: 60, cacheWrite: 20 } },
        } : part));
      }

      if (script === "approve" || script === "question") {
        // Ask while the ask's own tool result is not the LAST message
        // (the old "any tool message anywhere" skipped the ask when a
        // replayed slice carried an earlier tool result). The ask's
        // tool-call id is derived from the conversation's own sends so
        // two conversations can never collide on the pending_inputs PK
        // (recordPendingInput is conflict-do-nothing — a shared fixed id
        // made one test's card silently swallow another's; the CI flake,
        // 2026-10-17).
        const lastIsAskResult =
          options.prompt[options.prompt.length - 1]?.role === "tool";
        const askId = askCallId(userTexts(options.prompt));
        if (!lastIsAskResult) {
          return result(
            toolCallPart(
              askId,
              "ask_owner",
              script === "question"
                ? { kind: "question", question: "Which database should we use?" }
                : { kind: "approval", question: "Proceed with the spike?" },
            ),
          );
        }
        // Echo the tool result back so the test can see it round-tripped.
        const toolMessage = options.prompt.find((m) => m.role === "tool");
        return result(textPart(`mock-after:${toolMessage ? messageText(toolMessage) : "no-tool-message"}`));
      }

      // 0081: a structured ask_owner call — one single-type question,
      // two options (one recommended), a context block, and a code
      // evidence attachment on the recommended option.
      if (script === "structured-question") {
        const lastIsAskResult = options.prompt[options.prompt.length - 1]?.role === "tool";
        const askId = askCallId(userTexts(options.prompt)).replace("call_ask_", "call_structured_");
        if (!lastIsAskResult) {
          return result(
            toolCallPart(askId, "ask_owner", {
              kind: "question",
              question: "Which database should we use?",
              context: "sqlite is simpler to operate; postgres scales further.",
              questions: [
                {
                  id: "db",
                  header: "Database",
                  type: "single",
                  options: [
                    { id: "sqlite", label: "sqlite", description: "simplest to operate", recommended: true, evidence: { type: "code", lang: "ts", text: "export const db = () => new Database(path);" } },
                    { id: "postgres", label: "postgres", description: "scales further" },
                  ],
                },
              ],
            }),
          );
        }
        const toolMessage = options.prompt.find((m) => m.role === "tool");
        return result(textPart(`mock-after:${toolMessage ? messageText(toolMessage) : "no-tool-message"}`));
      }

      // 0059: use_skill with no id lists the catalog. The tool's own
      // result lands in the persisted history regardless of what this
      // script echoes back.
      if (script === "skill") {
        if (!sawToolResult) {
          return result(toolCallPart("call_skill_1", "use_skill", {}));
        }
        return result(textPart("mock-skill-done"));
      }

      // 0037: a turn that never stops calling tools — exhausts its budget.
      if (script === "loop") {
        const n = options.prompt.filter((m) => m.role === "tool").length;
        return result(toolCallPart(`call_loop_${n}`, "note", { note: `loop ${n}` }));
      }

      if (script === "steer") {
        if (!sawToolResult) {
          return result(
            toolCallPart("call_note_1", "note", { note: "slice one" }),
          );
        }
        const steered = userTexts(options.prompt).includes("STEER_MARKER");
        return result(
          textPart(steered ? "mock-steer-saw:STEER_MARKER" : "mock-steer-missed"),
        );
      }

      // 0034 Phase A: a scripted create_pr round trip — the call must
      // suspend on Chad's approval (token = the tool call id) before the
      // host is ever hit.
      if (script === "create-pr") {
        if (!sawToolResult) {
          return result(
            toolCallPart("call_pr_1", "create_pr", {
              repo: "r",
              head: "feat/trial",
              title: "Trial PR",
            }),
          );
        }
        const toolMessage = options.prompt.find((m) => m.role === "tool");
        return result(textPart(`mock-after:${toolMessage ? messageText(toolMessage) : "no-tool-message"}`));
      }

      // 0064: proposing an outline opens a hookless review and the turn
      // continues immediately to its next model slice.
      if (script === "outline-propose") {
        if (!sawToolResult) {
          const callId = askCallId(userTexts(options.prompt)).replace("call_ask_", "call_outline_");
          return result(toolCallPart(callId, "update_outline", {
            goal: "Ship the widget",
            steps: [{ id: "build", label: "Build", state: "active" }],
            propose: true,
          }));
        }
        return result(textPart("mock-outline-continued"));
      }

      // 0015: report how many "[viewing]" notes the model was shown (the
      // current send's + injected history ones). Notes are user-role
      // messages that START with the prefix; the instructions merely
      // mention it mid-text, and real user text never starts with it.
      if (script === "viewing") {
        const notes = options.prompt.filter(
          (m) => m.role === "user" && messageText(m).startsWith("[viewing]"),
        ).length;
        return result(textPart(`mock-viewing:${notes}`));
      }

      // 0055: report how many "[thread state]" notes the model was shown
      // this turn — present (exactly once) for a moded conversation with
      // a phase set, absent for a plain chat or a legacy ticket-skill
      // thread (bound before 0055, null phase).
      if (script === "thread-state") {
        const notes = options.prompt.filter(
          (m) => m.role === "user" && messageText(m).startsWith("[thread state]"),
        ).length;
        return result(textPart(`mock-thread-state:${notes}`));
      }

      // 0042: report what the model received for each image part — the
      // resolved bytes' size and media type, or the placeholder text.
      if (script === "images") {
        const seen: string[] = [];
        for (const m of options.prompt) {
          if (m.role !== "user" || typeof m.content === "string") continue;
          for (const part of m.content) {
            if (part.type === "file") {
              // v4 prompts carry tagged data ({type:"data"|"url"}); accept bare
              // bytes/URLs too.
              let d = part.data as unknown;
              const tagged = d as { type?: string; data?: unknown; url?: unknown } | null;
              if (tagged && typeof tagged === "object" && !(d instanceof Uint8Array) && !(d instanceof URL)) {
                d = tagged.type === "url" ? tagged.url : tagged.data;
              }
              if (d instanceof Uint8Array) seen.push(`bytes:${d.byteLength}:${part.mediaType}`);
              else if (d instanceof URL) seen.push(`url:${d.toString()}`);
              else if (typeof d === "string") seen.push(`string:${d.slice(0, 40)}`);
              else seen.push(`other:${typeof d}`);
            } else if (part.type === "text" && part.text.startsWith("[image")) {
              seen.push(part.text);
            }
          }
        }
        return result(textPart(`mock-images:${seen.join("|")}`));
      }

      // plain: reply with the user-message count — proves the turn loaded
      // the conversation's full persisted history.
      return result(textPart(`mock-reply:${userTexts(options.prompt).length}`));
    },
  });
}
