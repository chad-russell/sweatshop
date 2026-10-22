import { createUIMessageStreamResponse } from "ai";
import { NextResponse } from "next/server";
import { getRun } from "workflow/api";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import {
  ensureConversation,
  enqueueSteer,
  getActiveRun,
  getConversation,
  listMessageTexts,
  listMessageTextsPage,
  setActiveRun,
  setConversationSkill,
  setConversationRoute,
} from "@/db/chat";
import { deriveChatContext, rowsToUIMessages } from "@/lib/chat-ui";
import { disableConversationSandbox, getConversationBinding } from "@/db/sandboxes";
import { getProject } from "@/db/projects";
import { getProjectModels } from "@/db/providers";
import { validationContext } from "@/lib/providers/resolve";
import { chatRouteSchema, parseRouteAs, validateRoute } from "@/lib/providers/route";
import { parseViewingContext } from "@/lib/page-context";
import { attachConversation } from "@/lib/sandboxes/binding";
import { ACTIVE_RUN_STATUSES as ACTIVE, startChatTurn } from "@/lib/chat/start-turn";
import { answerPendingWithText } from "@/lib/chat/answer-pending";
import { listThreadSkills } from "@/lib/skills";
import { checkClaimable } from "@/db/attachments";
import { MAX_IMAGES_PER_MESSAGE, parseAttachmentRef } from "@/lib/attachments";

export const dynamic = "force-dynamic";

/**
 * 0010 turn starter (Phase 4 cutover: the chat surface's transport).
 * Project and model are plain conversation columns — set here on send.
 * 0013: the sandbox is chosen once, by the send that creates the
 * conversation ("none", or "attached:<sandboxId>" to copy that
 * sandbox's binding; omitted = its own, created on first use). Later
 * sends cannot change it. If a turn is live
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
    /** 0021: the picker's route ({ provider, model }); null = clear
     *  (inherit the project / global default); absent = unchanged. */
    route?: unknown;
    /** Conversation-creation binding (landing pages). */
    projectId?: unknown;
    /** 0013, creation only: "none" | "attached:<sandboxId>" | null (own). */
    sandbox?: string | null;
    /** 0015: the page the send came from (the agent panel's viewing note). */
    context?: unknown;
    /** 0039, creation only: the skill this thread runs. */
    skill?: unknown;
    messages?: { role: string; parts?: { type: string; text?: string; url?: string }[] }[];
  };
  const transportText = body.messages
    ?.filter((m) => m.role === "user")
    .at(-1)
    ?.parts?.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
    .join("");
  const text = (body.text ?? transportText ?? "").trim();
  // 0042: uploaded images ride as file parts whose url is the serving
  // path (/api/attachments/att_…); the ids are all the server needs.
  const attachmentIds = (body.messages?.filter((m) => m.role === "user").at(-1)?.parts ?? []).flatMap((part) => {
    if (part.type !== "file" || typeof part.url !== "string") return [];
    const id = part.url.split("/").pop() ?? "";
    return [parseAttachmentRef(`attachment:${id}`) ?? `invalid:${id}`];
  });
  // WorkflowChatTransport callers (`messages` present) need the turn's UI
  // stream plus an `x-workflow-run-id` header; plain fetch callers (steer)
  // get JSON.
  const wantsStream = body.text === undefined && body.messages !== undefined;
  // 0076: a steered send must NOT replay the run's stream. The caller's
  // window already renders the turn by persisted slices (polls); a
  // from-0 replay would land the whole turn a second time under the
  // steer (duplicate + multi-second replay). Instead: enqueue the steer
  // and return a finished empty stream — the slices (steer drain, the
  // turn's continuation) arrive through the slice poll like every other
  // slice. The sending tab's optimistic user row renders immediately.
  const respond = (runId: string, steered: boolean) =>
    wantsStream
      ? createUIMessageStreamResponse({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "start" });
              controller.enqueue({ type: "finish" });
              controller.close();
            },
          }),
          headers: { "x-workflow-run-id": runId },
        })
      : NextResponse.json({ runId, steered });
  if (!body.conversationId || (!text && attachmentIds.length === 0)) {
    return NextResponse.json(
      { error: "conversationId and non-empty text (or an image) are required" },
      { status: 400 },
    );
  }
  if (attachmentIds.length > MAX_IMAGES_PER_MESSAGE) {
    return NextResponse.json(
      { error: `at most ${MAX_IMAGES_PER_MESSAGE} images per message` },
      { status: 400 },
    );
  }
  const badId = attachmentIds.find((id) => id.startsWith("invalid:"));
  if (badId) {
    return NextResponse.json({ error: `bad attachment id ${badId.slice(8)}` }, { status: 400 });
  }
  const claim = checkClaimable(db(), attachmentIds, body.conversationId);
  if (!claim.ok) {
    return NextResponse.json({ error: claim.error }, { status: 400 });
  }
  if (body.sandbox != null && !isValidSandboxChoice(body.sandbox)) {
    return NextResponse.json({ error: "invalid sandbox choice" }, { status: 400 });
  }

  // 0021: validate a picked route against the conversation's project
  // BEFORE creating anything — a rejected route sends nothing.
  const existing = getConversation(db(), body.conversationId);
  // The creating send binds the project (0004/0013: once, for life) — it
  // must name a real one, or the insert dies on the foreign key. Later
  // sends' projectId is ignored (the binding never switches).
  if (!existing && body.projectId != null) {
    if (typeof body.projectId !== "string" || !body.projectId) {
      return NextResponse.json({ error: "projectId must be a project id string" }, { status: 400 });
    }
    if (!getProject(db(), body.projectId)) {
      return NextResponse.json({ error: `project ${body.projectId} not found` }, { status: 404 });
    }
  }
  const projectId = existing ? existing.projectId : ((body.projectId as string | undefined) ?? null);
  // 0039: a skill is chosen by the creating send (use_skill covers
  // later); unknown ids reject before anything is created. 0054: a new
  // binding can only pick an ACTIVE thread skill — readSkill would also
  // resolve a disabled/deleted one (that's its whole point for a thread
  // already running one), which is wrong for a brand-new bind.
  const skill = !existing && typeof body.skill === "string" && body.skill ? body.skill : null;
  if (skill && !(await listThreadSkills()).some((s) => s.id === skill)) {
    return NextResponse.json({ error: `no skill "${skill}"` }, { status: 400 });
  }
  let pickedRoute: import("@/lib/providers/route").ChatRoute | null | undefined;
  if (body.route !== undefined) {
    if (body.route === null) {
      pickedRoute = null;
    } else {
      const parsed = parseRouteAs(chatRouteSchema, body.route);
      const check = parsed.ok
        ? validateRoute(parsed.route, validationContext(db(), getProjectModels(db(), projectId)))
        : parsed;
      if (!check.ok) {
        return NextResponse.json({ error: "invalid route", issues: check.issues }, { status: 400 });
      }
      pickedRoute = parsed.ok ? parsed.route : undefined;
    }
  }
  if (!existing) {
    ensureConversation(db(), body.conversationId, projectId);
    if (skill) setConversationSkill(db(), body.conversationId, skill);
    if (body.sandbox === "none") {
      disableConversationSandbox(db(), body.conversationId);
    } else if (body.sandbox?.startsWith("attached:")) {
      try {
        await attachConversation(body.conversationId, body.sandbox.slice("attached:".length));
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "could not attach" },
          { status: 409 },
        );
      }
    }
  }
  if (pickedRoute !== undefined) setConversationRoute(db(), body.conversationId, pickedRoute);

  let active = getActiveRun(db(), body.conversationId);
  if (active) {
    if (ACTIVE.has(await getRun(active).status)) {
      // 0037: a turn suspended on Chad (approval/question) takes the
      // typed text as the ANSWER — a revise for approvals (denied with
      // the text as the comment), the reply for questions. A steer would
      // only drain after the hook resolves, i.e. never.
      if (attachmentIds.length > 0) {
        return NextResponse.json(
          { error: "images can't be added while a turn is running — wait for it to finish" },
          { status: 409 },
        );
      }
      const answered = await answerPendingWithText(body.conversationId, text);
      if (answered) {
        // 0076: transport callers get the empty finished stream (the
        // hook's answer drives the turn; its slices arrive by poll —
        // never a from-0 replay). Plain fetch callers learn what their
        // text answered.
        return wantsStream ? respond(active, true) : NextResponse.json({ runId: active, steered: false, answered });
      }
      enqueueSteer(db(), body.conversationId, text);
      return respond(active, true);
    }
    setActiveRun(db(), body.conversationId, null);
    active = null;
  }

  const run = await startChatTurn(
    body.conversationId,
    text,
    // 0015: invalid/absent context simply sends no note.
    parseViewingContext(body.context) ?? undefined,
    undefined,
    attachmentIds,
  );
  return respond(run.runId, false);
}

function isValidSandboxChoice(value: string): boolean {
  return value === "none" || /^attached:sbx_[\w-]+$/.test(value);
}

/** Conversation state for the chat surface (reload/initial render).
 *  0075: `tail` pages newest-first (with an `olderCursor` rowid for the
 *  previous page and `olderRemaining` for the load-earlier count);
 *  `context=1` adds the server-derived header facts over the whole
 *  transcript so a tail-hydrated page still shows them. Without
 *  params, today's exact shape and content. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const conversationId = params.get("conversationId");
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }
  const tailRaw = params.get("tail");
  const beforeRaw = params.get("before");
  const wantsContext = params.get("context") === "1";
  const MAX_TAIL = 1000;
  let tail: number | undefined;
  if (tailRaw != null) {
    tail = Number(tailRaw);
    if (!Number.isInteger(tail) || tail < 1 || tail > MAX_TAIL) {
      return NextResponse.json({ error: `tail must be an integer between 1 and ${MAX_TAIL}` }, { status: 400 });
    }
  }
  let before: number | undefined;
  if (beforeRaw != null) {
    before = Number(beforeRaw);
    if (!Number.isInteger(before) || before < 1) {
      return NextResponse.json({ error: "before must be a positive integer rowid" }, { status: 400 });
    }
  }
  const paged = tailRaw != null || beforeRaw != null;
  const page = listMessageTextsPage(db(), conversationId, paged ? { tail, before } : {});
  const conversation = getConversation(db(), conversationId);
  return NextResponse.json({
    messages: page.rows,
    ...(paged ? { olderCursor: page.olderCursor, olderRemaining: page.olderRemaining } : {}),
    ...(wantsContext
      ? { context: deriveChatContext(rowsToUIMessages(listMessageTexts(db(), conversationId))) }
      : {}),
    activeRunId: getActiveRun(db(), conversationId),
    route: conversation?.route ?? null,
    sandbox: getConversationBinding(db(), conversationId),
    projectId: conversation?.projectId ?? null,
    title: db()
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()?.title ?? null,
  });
}
