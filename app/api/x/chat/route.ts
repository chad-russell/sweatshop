import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse } from "ai";
import { NextResponse } from "next/server";
import { getRun, start } from "workflow/api";
import { db } from "@/db";
import {
  ensureConversation,
  enqueueSteer,
  getActiveRun,
  getConversation,
  listMessageTexts,
  setActiveRun,
  updateConversationSettings,
} from "@/db/chat";
import { resolveChatModel } from "@/lib/model";
import { chatTurn } from "@/workflows/chat/turn";

export const dynamic = "force-dynamic";

/** Statuses a queued steer message can still land inside. */
const ACTIVE = new Set(["pending", "running"]);

/**
 * 0010 turn starter (Phase 4 cutover: the chat surface's transport).
 * Project, model and sandbox pref are plain conversation columns — set
 * here on send, no headers or principal attributes. If a turn is live
 * for the conversation, the text is queued as steer (drained between
 * slices); otherwise a new one-run-per-turn workflow starts. Stale
 * active rows (a run that finished before the route could clear it) are
 * swept here.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    conversationId?: string;
    /** Explicit text (steer/fetch callers) — else taken from the last
     * user message in `messages` (WorkflowChatTransport callers). */
    text?: string;
    modelId?: string;
    /** Conversation-creation binding (landing pages). */
    projectId?: string;
    /** Explicit sandbox choice: "none" | "attached:<sandboxId>" | null. */
    sandboxPref?: string | null;
    messages?: { role: string; parts?: { type: string; text?: string }[] }[];
  };
  const transportText = body.messages
    ?.filter((m) => m.role === "user")
    .at(-1)
    ?.parts?.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
    .join("");
  const text = (body.text ?? transportText ?? "").trim();
  // WorkflowChatTransport callers (`messages` present) need the turn's UI
  // stream plus an `x-workflow-run-id` header; plain fetch callers (steer)
  // get JSON.
  const wantsStream = body.text === undefined && body.messages !== undefined;
  const respond = (runId: string, steered: boolean) =>
    wantsStream
      ? createUIMessageStreamResponse({
          stream: getRun(runId)
            .getReadable({ startIndex: 0 })
            .pipeThrough(createModelCallToUIChunkTransform({ uiStartIndex: 0 })),
          headers: { "x-workflow-run-id": runId },
        })
      : NextResponse.json({ runId, steered });
  if (!body.conversationId || !text) {
    return NextResponse.json(
      { error: "conversationId and non-empty text are required" },
      { status: 400 },
    );
  }
  if (body.sandboxPref != null && !isValidSandboxPref(body.sandboxPref)) {
    return NextResponse.json({ error: "invalid sandboxPref" }, { status: 400 });
  }

  const existing = getConversation(db(), body.conversationId);
  if (!existing) {
    ensureConversation(db(), body.conversationId, body.projectId ?? null);
  }
  updateConversationSettings(db(), body.conversationId, {
    ...(body.modelId ? { modelId: resolveChatModel(body.modelId).id } : {}),
    ...(body.sandboxPref !== undefined ? { sandboxPref: body.sandboxPref } : {}),
  });
  const conversation = getConversation(db(), body.conversationId)!;
  const model = resolveChatModel(conversation.modelId);

  let active = getActiveRun(db(), body.conversationId);
  if (active) {
    if (ACTIVE.has(await getRun(active).status)) {
      enqueueSteer(db(), body.conversationId, text);
      return respond(active, true);
    }
    setActiveRun(db(), body.conversationId, null);
    active = null;
  }

  const run = await start(chatTurn, [
    {
      conversationId: body.conversationId,
      userText: text,
      modelId: model.id,
      sandboxPref: conversation.sandboxPref,
      hasProject: !!conversation.projectId,
    },
  ]);
  // The run may complete before this write lands (fast turns); that is
  // fine — the next POST sweeps a stale row via the status check above.
  if (ACTIVE.has(await run.status)) {
    setActiveRun(db(), body.conversationId, run.runId);
  }
  return respond(run.runId, false);
}

function isValidSandboxPref(value: string): boolean {
  return value === "none" || value.startsWith("attached:");
}

/** Conversation state for the chat surface (reload/initial render). */
export async function GET(request: Request) {
  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }
  const conversation = getConversation(db(), conversationId);
  return NextResponse.json({
    messages: listMessageTexts(db(), conversationId),
    activeRunId: getActiveRun(db(), conversationId),
    modelId: conversation?.modelId ?? null,
    sandboxPref: conversation?.sandboxPref ?? null,
    projectId: conversation?.projectId ?? null,
  });
}
