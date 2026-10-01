"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import { useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";

/**
 * 0010 spike page — deliberately plain. It exercises the new runtime's
 * client surface (useChat + WorkflowChatTransport, steer while
 * streaming, cancel, approval card) without touching the real chat.tsx;
 * the Phase 4 cutover rebuilds the real UI on AI Elements.
 */

interface ToolAskChadPart {
  type: "tool-ask_chad";
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: { question?: string };
  output?: string;
}

export default function XSpikePage() {
  const [conversationId] = useState(() => `c_${nanoid()}`);
  const inputRef = useRef<HTMLInputElement>(null);
  const [steerNote, setSteerNote] = useState<string | null>(null);

  const [transport] = useState(
    () =>
      new WorkflowChatTransport({
        api: "/api/x/chat",
        prepareSendMessagesRequest: ({ messages, trigger, messageId }) => ({
          body: { conversationId, modelId: "glm-5.3-flash", messages, trigger, messageId },
        }),
      }),
  );

  const { messages, sendMessage, status, stop } = useChat({ transport });

  // Fresh id per mount: the spike never resumes an old conversation.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const busy = status === "submitted" || status === "streaming";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const input = inputRef.current;
    if (!input?.value.trim()) return;
    const text = input.value;
    input.value = "";
    if (busy) {
      // A live turn: this is a steer, queued for the next model step.
      const res = await fetch("/api/x/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, text }),
      });
      const body = (await res.json()) as { steered?: boolean; error?: string };
      setSteerNote(body.steered ? "steered into the running turn" : (body.error ?? "queued"));
      setTimeout(() => setSteerNote(null), 4_000);
    } else {
      setSteerNote(null);
      void sendMessage({ text });
    }
  }

  async function cancel() {
    stop();
    await fetch("/api/x/chat/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });
  }

  async function answer(toolCallId: string, approved: boolean) {
    await fetch("/api/x/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolCallId, approved }),
    });
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 p-6">
      <header className="text-sm text-muted-foreground">
        <p>
          0010 spike — new chat runtime (WorkflowAgent turns). Conversation{" "}
          <code>{conversationId}</code>
        </p>
        <p>
          status: <code>{status}</code>
          {steerNote ? ` — ${steerNote}` : ""}
        </p>
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
        {messages.map((message) => (
          <div key={message.id} className="rounded-md border p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {message.role}
            </div>
            {message.parts.map((part, i) => {
              if (part.type === "text") {
                return (
                  <p key={i} className="whitespace-pre-wrap">
                    {part.text}
                  </p>
                );
              }
              const ask = part as unknown as ToolAskChadPart;
              if (ask.type === "tool-ask_chad") {
                const answered = ask.state === "output-available" || ask.state === "output-error";
                return (
                  <div key={i} className="mt-2 rounded border border-amber-600/40 bg-amber-500/5 p-2 text-sm">
                    <p className="font-medium">ask_chad: {ask.input?.question}</p>
                    {!answered ? (
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          className="rounded bg-primary px-3 py-1 text-primary-foreground"
                          onClick={() => void answer(ask.toolCallId, true)}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="rounded border px-3 py-1"
                          onClick={() => void answer(ask.toolCallId, false)}
                        >
                          Deny
                        </button>
                      </div>
                    ) : (
                      <p className="mt-1 text-muted-foreground">{ask.output ?? String(ask.state)}</p>
                    )}
                  </div>
                );
              }
              if (part.type === "tool-note") {
                return (
                  <p key={i} className="text-xs text-muted-foreground">
                    note tool called
                  </p>
                );
              }
              return null;
            })}
          </div>
        ))}
      </div>

      <form onSubmit={submit} className="flex gap-2">
        <input
          ref={inputRef}
          className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
          placeholder={busy ? "Steer the running turn…" : "Send a message"}
        />
        {busy ? (
          <button
            type="button"
            className="rounded-md border px-3 py-2 text-sm"
            onClick={() => void cancel()}
          >
            Stop
          </button>
        ) : (
          <button type="submit" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">
            {busy ? "Steer" : "Send"}
          </button>
        )}
      </form>
    </main>
  );
}
