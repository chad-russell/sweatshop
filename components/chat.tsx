"use client";

import type { ChatStatus } from "ai";
import { MessageSquarePlus, SquarePen } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { memo } from "react";
import {
  useEveAgent,
  type EveDynamicToolPart,
  type EveMessage,
  type UseEveAgentStatus,
} from "eve/react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolPart,
} from "@/components/ai-elements/tool";
import { ThemeToggle } from "@/components/theme-toggle";
import { Spinner } from "@/components/ui/spinner";
import { useMounted } from "@/lib/use-mounted";

/** eve status → the ChatStatus shape PromptInputSubmit understands. */
function toChatStatus(status: UseEveAgentStatus): ChatStatus {
  // "resuming" disables submission anyway; "submitted" gives the right
  // disabled-submit presentation while catch-up runs.
  return status === "resuming" ? "submitted" : status;
}

/** True while a turn is running but no answer text has started. */
function isThinking(status: UseEveAgentStatus, messages: readonly EveMessage[]) {
  if (status === "submitted") return true;
  if (status !== "streaming") return false;
  const last = messages[messages.length - 1];
  return !(
    last?.role === "assistant" &&
    last.parts.some((part) => part.type === "text" && part.text)
  );
}

/** One tool call, collapsed by default: header (name + lifecycle state),
 *  expandable to the JSON input and output/error. */
const ToolCallView = ({ part }: { part: EveDynamicToolPart }) => {
  const input = part.state === "input-streaming" ? undefined : part.input;
  const output = part.state === "output-available" ? part.output : undefined;
  const errorText =
    part.state === "output-error" ? (part.errorText ?? "tool failed") : undefined;
  return (
    <Tool>
      {/* eve's state union is a superset of the kit's (approval states);
          the kit's badges cover the overlap. */}
      <ToolHeader
        type="dynamic-tool"
        state={part.state as ToolPart["state"]}
        toolName={part.toolName}
      />
      <ToolContent>
        {input !== undefined && <ToolInput input={input} />}
        {(output !== undefined || errorText !== undefined) && (
          <ToolOutput
            output={output as ToolPart["output"]}
            errorText={errorText as ToolPart["errorText"]}
          />
        )}
      </ToolContent>
    </Tool>
  );
};

/**
 * Render one eve message with the AI Elements kit. EveMessage parts follow
 * the UIMessage rendering convention: text streams through
 * MessageResponse, model reasoning through the collapsible Reasoning kit,
 * tool calls through the Tool kit. Parts we don't render yet (HITL
 * approval prompts, authorization challenges) are skipped.
 *
 * Memoized on message identity: eve's reducer clones only the streaming
 * message per delta, so during a turn every completed message — including
 * its markdown re-parse — skips re-render.
 */
export const EveMessageView = memo(function EveMessageView({
  message,
}: {
  message: EveMessage;
}) {
  return (
    <Message
      from={message.role}
      className="[content-visibility:auto] [contain-intrinsic-size:auto_80px]"
    >
      <MessageContent>
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return <MessageResponse key={i}>{part.text}</MessageResponse>;
          }
          if (part.type === "reasoning" && part.text) {
            return (
              <Reasoning key={i} isStreaming={part.state === "streaming"}>
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            );
          }
          if (part.type === "dynamic-tool") {
            return <ToolCallView key={i} part={part} />;
          }
          return null;
        })}
      </MessageContent>
    </Message>
  );
});

/**
 * The sweatshop chat surface (0002): one durable eve session per
 * conversation, driven by useEveAgent. Conversations are URL-addressed —
 * `/` starts fresh and the URL is replaced with `/c/[sessionId]` once the
 * first send creates the session (no remount, per the generated-web-chat
 * pattern); opening `/c/[sessionId]` resumes by replaying the durable
 * stream from index 0.
 */
export function ChatSurface({
  sessionId,
  projectId,
  projectName,
}: {
  sessionId?: string;
  projectId?: string;
  projectName?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // With resume: true the hook's client-first status is "resuming" while
  // the server rendered "ready" — render a deterministic "ready" until
  // hydration completes so disabled states can't mismatch.
  const mounted = useMounted();

  const agent = useEveAgent({
    initialSession: sessionId ? { sessionId, streamIndex: 0 } : undefined,
    resume: sessionId !== undefined,
    // Project binding rides session creation: the channel lifts the
    // header into the session principal (immutable for its life).
    headers: projectId
      ? () => ({ "x-sweatshop-project": projectId })
      : undefined,
    onSessionChange(session) {
      // From a landing page, adopt the new session's URL without
      // remounting the active stream. On /c/[sessionId] the URL is
      // already correct.
      if (!session || sessionId) return;
      window.history.replaceState(null, "", `/c/${session.sessionId}`);
    },
  });

  const displayStatus = mounted ? agent.status : "ready";
  const isBusy = displayStatus === "submitted" || displayStatus === "streaming";
  const isResuming = displayStatus === "resuming";
  const inputDisabled = isResuming;
  const messages = agent.data.messages;

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text?.trim();
    if (!text || inputDisabled) return;
    void agent.send(text, isBusy ? { turnPolicy: "steer" } : undefined);
  };

  const handleNewChat = () => {
    if (projectId) {
      // On a project page (or its adopted /c/... URL): reset in place —
      // the project header rebinds the next session to the same project.
      window.history.replaceState(null, "", `/p/${projectId}`);
      agent.reset();
    } else if (pathname === "/") {
      // Still on the landing route (URL may have been replaced to /c/...):
      // reset local state and the URL in place — the prior durable session
      // remains available at its URL.
      window.history.replaceState(null, "", "/");
      agent.reset();
    } else {
      // On /c/[sessionId]: navigate to the sessionless landing route.
      router.push("/");
    }
  };

  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <span className="font-mono text-sm text-muted-foreground">
          sweatshop{projectName ? ` / ${projectName}` : ""}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="New chat"
            title="New chat"
            disabled={isResuming}
            onClick={handleNewChat}
            className="inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <SquarePen className="size-4" />
          </button>
          <ThemeToggle />
        </div>
      </header>

      <Conversation className="min-h-0 flex-1">
        <ConversationContent>
          {messages.length === 0 && displayStatus === "ready" && !agent.error && (
            <ConversationEmptyState
              icon={<MessageSquarePlus className="size-6" />}
              title="sweatshop"
              description="A conversation with your agent. Say anything to begin."
            />
          )}
          {messages.map((message) => (
            <EveMessageView key={message.id} message={message} />
          ))}
          {isThinking(displayStatus, messages) && (
            <div
              className="flex items-center gap-2 py-2 text-sm text-muted-foreground"
              role="status"
            >
              <Spinner className="size-4" />
              Thinking…
            </div>
          )}
          {agent.error && (
            <p className="py-2 text-sm text-destructive">
              {agent.error.message}
            </p>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t p-4">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputTextarea
            placeholder="Message sweatshop…"
            disabled={inputDisabled}
          />
          <PromptInputSubmit
            status={toChatStatus(displayStatus)}
            onStop={() => void agent.cancel()}
          />
        </PromptInput>
      </div>
    </div>
  );
}
