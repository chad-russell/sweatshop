import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { listMessageTexts } from "@/db/chat";
import {
  getConversationBinding,
  getLease,
  type BoundSandbox,
} from "@/db/sandboxes";
import { conversations, harnessCalls, harnessEvents, harnessRuns } from "@/db/schema";
import { listHostCommands } from "@/db/host-commands";
import { clipOutput } from "@/lib/agent/tools/bash";
import { openSandbox } from "@/lib/sandboxes/binding";
import type { SandboxProvider } from "@/lib/sandboxes/provider";
import { clipHead } from "@/lib/clip";

/**
 * 0013 Phase 6 — post-mortems from outside. Two chat tools, available
 * with or without a project, so looking at another chat never requires
 * joining its sandbox:
 *
 *   inspect       read-only: a chat's transcript tail, harness activity,
 *                 and sandbox binding (the binding is the record of
 *                 where calls ran — 0031).
 *   sandbox_exec  one command in a named sandbox without binding to it
 *                 (resumes a stopped one; never stops or destroys).
 *                 Starting an agent inside it is a new chat that
 *                 attaches.
 *
 * Results are clipped plain data — they land in the model's context.
 */

const TAIL_MESSAGES = 20;
const MESSAGE_CLIP = 1_500;
const HARNESS_EVENTS = 30;
const HOST_COMMANDS = 10;

function sandboxSummary(binding: BoundSandbox | null) {
  if (!binding) return null;
  const lease = getLease(db(), binding.sandboxId);
  return {
    sandboxId: binding.sandboxId,
    workDir: binding.workDir,
    owner: binding.owner,
    status: lease?.status ?? "missing",
  };
}

function transcriptTail(conversationId: string) {
  const rows = listMessageTexts(db(), conversationId);
  return {
    totalMessages: rows.length,
    tail: rows.slice(-TAIL_MESSAGES).map((m) => ({ role: m.role, at: m.at, text: clipHead(m.text ?? "", MESSAGE_CLIP) })),
  };
}

function harnessActivity(sessionId: string) {
  const runs = db()
    .select()
    .from(harnessRuns)
    .where(eq(harnessRuns.sessionId, sessionId))
    .all()
    .map((r) => ({ harness: r.kind, status: r.status, toolCalls: r.toolCalls, error: r.error }));
  if (runs.length === 0) return null;
  const events = db()
    .select()
    .from(harnessEvents)
    .where(eq(harnessEvents.sessionId, sessionId))
    .orderBy(desc(harnessEvents.id))
    .limit(HARNESS_EVENTS)
    .all()
    .reverse()
    .map((e) => ({
      harness: e.harness,
      kind: e.kind,
      tool: e.toolName,
      ...(e.input ? { input: clipHead(e.input, 300) } : {}),
      ...(e.output ? { output: clipHead(e.output, 500) } : {}),
      ...(e.text ? { text: clipHead(e.text, 300) } : {}),
    }));
  return { runs, recentEvents: events };
}

/** 0043: the conversation's recent host-channel commands (audit trail). */
function hostActivity(conversationId: string) {
  const rows = listHostCommands(db(), conversationId, HOST_COMMANDS);
  if (rows.length === 0) return null;
  return rows.map((c) => ({
    host: c.hostName,
    command: clipHead(c.command, 400),
    exit: c.exitCode,
    ran: c.resolvedAt !== null,
    at: c.createdAt,
  }));
}

export type InspectResult = Record<string, unknown>;

/**
 * Inspect a conversation by id (`c_…`) or a background harness call
 * (`hc_…`). Read-only.
 */
export function inspectTarget(id: string): InspectResult {
  // 0022: a background harness call — status, its task, and where it runs.
  if (id.startsWith("hc_")) {
    const call = db().select().from(harnessCalls).where(eq(harnessCalls.id, id)).get();
    if (!call) return { kind: "error", code: "unknown-id", message: `no harness call "${id}"` };
    const binding = getConversationBinding(db(), call.conversationId);
    const events = harnessActivity(call.conversationId);
    return {
      kind: "harness-call",
      id,
      harness: call.kind,
      status: call.status,
      task: clipHead(call.task, 1_000),
      ...(call.error ? { error: clipHead(call.error, 500) } : {}),
      ...(call.result ? { result: clipHead(call.result, 1_500) } : {}),
      // 0040 phase 3 (review fix): the path `harnessSettleStep` actually
      // wrote, read back verbatim — never derived/guessed, so this is
      // never a path `cat` 404s on.
      ...(call.resultFile ? { resultFile: call.resultFile } : {}),
      conversation: call.conversationId,
      eventsUrl: `/h/${call.kind}/${call.conversationId}/${call.id}`,
      sandbox: binding?.kind === "bound" ? sandboxSummary(binding) : null,
      ...(events ? { recentEvents: events.recentEvents } : {}),
      hint: "cancel_run stops it; the conversation is woken when it settles.",
    };
  }

  const row = db()
    .select({
      id: conversations.id,
      kind: conversations.kind,
      title: conversations.title,
      projectId: conversations.projectId,
      activeRunId: conversations.activeRunId,
      parentConversationId: conversations.parentConversationId,
      resultFile: conversations.resultFile,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  if (!row) {
    // 2026-10-09 post-mortem: unknown ids are a VALUE, not a throw — a
    // typo'd id in a live turn retried 4x uselessly and killed the whole
    // wake turn; the model self-corrects on the shaped error.
    return { kind: "error", code: "unknown-id", message: `nothing to inspect: no chat or run "${id}"` };
  }

  const binding = getConversationBinding(db(), id);
  return {
    kind: row.kind,
    id,
    title: row.title,
    projectId: row.projectId,
    busy: Boolean(row.activeRunId),
    ...transcriptTail(id),
    harness: harnessActivity(id),
    hostCommands: hostActivity(id),
    sandbox:
      binding?.kind === "bound"
        ? sandboxSummary(binding)
        : { state: binding?.kind === "pending" ? "pending (created on first use)" : "none" },
    // 0040 phase 3 (review fix): only for a start_thread child
    // (row.parentConversationId set) — the path its LAST settle actually
    // wrote into the parent's sandbox, read back verbatim from
    // `conversations.result_file` (`wakeChatChildIfDue` is the only
    // writer). Never derived/guessed: null means no file exists, not
    // "couldn't compute one."
    ...(row.parentConversationId ? { resultFile: row.resultFile } : {}),
  };
}

/** Where a sandbox's owner works (the default directory for exec). */
function ownerWorkDir(sandboxId: string): string {
  const lease = getLease(db(), sandboxId);
  if (!lease) throw new Error(`no sandbox ${sandboxId}`);
  const holder =
    lease.ownerKind === "conversation"
      ? (() => {
          const b = getConversationBinding(db(), lease.ownerId);
          return b?.kind === "bound" ? b : null;
        })()
      : null;
  return holder?.sandboxId === sandboxId ? holder.workDir : `/work/${lease.ownerId}`;
}

/**
 * Resolve what sandbox_exec targets: a sandbox id, or a chat id (its
 * bound sandbox).
 */
export function resolveSandboxTarget(target: string): BoundSandbox {
  if (target.startsWith("sbx_")) {
    return { kind: "bound", sandboxId: target, workDir: ownerWorkDir(target), owner: false };
  }
  const kind = db()
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, target))
    .get()?.kind;
  if (!kind) throw new Error(`no sandbox or chat "${target}"`);
  const binding = (() => {
    const b = getConversationBinding(db(), target);
    return b?.kind === "bound" ? b : null;
  })();
  if (!binding) throw new Error(`${target} has no sandbox (yet)`);
  return { ...binding, owner: false };
}

export interface ExecResult {
  sandboxId: string;
  workDir: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one command in a sandbox without binding the caller to it. A
 * destroyed sandbox is refused (openSandbox explains); a stopped one is
 * resumed. Lifecycle is never touched otherwise.
 */
export async function sandboxExec(
  target: string,
  command: string,
  options: { workDir?: string; provider?: SandboxProvider } = {},
): Promise<ExecResult> {
  const binding = resolveSandboxTarget(target);
  const { handle, sandboxId, workDir } = await openSandbox(binding, options.provider);
  const result = await handle.run(command, undefined, options.workDir ?? workDir);
  return {
    sandboxId,
    workDir: options.workDir ?? workDir,
    exitCode: result.exitCode,
    stdout: clipOutput(result.stdout),
    stderr: clipOutput(result.stderr),
  };
}
