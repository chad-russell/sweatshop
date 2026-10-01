import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getRun, start } from "workflow/api";
import { db } from "@/db";
import {
  ensureConversation,
  enqueueSteer,
  getActiveRun,
  listMessageTexts,
  setActiveRun,
} from "@/db/chat";
import { resolveChatModel } from "@/lib/model";
import { chatTurn } from "@/workflows/chat/turn";

export const dynamic = "force-dynamic";

/** Statuses a queued steer message can still land inside. */
const ACTIVE = new Set(["pending", "running"]);

/**
 * 0010 spike turn starter. If a turn is live for the conversation, the
 * text is queued as steer (drained by the turn's prepareStep); otherwise
 * a new one-run-per-turn workflow starts. Stale active rows (a run that
 * finished before the route could clear it) are swept here.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    conversationId?: string;
    /** Explicit text (steer/fetch callers) — else taken from the last
     * user message in `messages` (WorkflowChatTransport callers). */
    text?: string;
    modelId?: string;
    messages?: { role: string; parts?: { type: string; text?: string }[] }[];
  };
  const transportText = body.messages
    ?.filter((m) => m.role === "user")
    .at(-1)
    ?.parts?.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
    .join("");
  const text = (body.text ?? transportText ?? "").trim();
  if (!body.conversationId || !text) {
    return NextResponse.json(
      { error: "conversationId and non-empty text are required" },
      { status: 400 },
    );
  }
  const model = resolveChatModel(body.modelId ?? null);

  let active = getActiveRun(db(), body.conversationId);
  if (active) {
    if (ACTIVE.has(await getRun(active).status)) {
      enqueueSteer(db(), body.conversationId, text);
      return NextResponse.json({ runId: active, steered: true });
    }
    setActiveRun(db(), body.conversationId, null);
    active = null;
  }

  ensureConversation(db(), body.conversationId);
  const run = await start(chatTurn, [
    {
      conversationId: body.conversationId,
      userText: text,
      modelId: model.id,
    },
  ]);
  // The run may complete before this write lands (fast turns); that is
  // fine — the next POST sweeps a stale row via the status check above.
  if (ACTIVE.has(await run.status)) {
    setActiveRun(db(), body.conversationId, run.runId);
  }
  return NextResponse.json({ runId: run.runId, steered: false });
}

/** Message rows for the spike page (reload/initial render). */
export async function GET(request: Request) {
  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }
  return NextResponse.json({
    messages: listMessageTexts(db(), conversationId),
    activeRunId: getActiveRun(db(), conversationId),
  });
}

/** Fresh conversation id for a new spike chat. */
export async function PUT() {
  const id = `c_${nanoid()}`;
  return NextResponse.json({ conversationId: id });
}
