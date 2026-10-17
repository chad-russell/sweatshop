import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { listMessageTexts } from "@/db/chat";
import { getRunBinding, listStageRuns } from "@/db/machines";
import {
  getConversationBinding,
  getLease,
  type BoundSandbox,
} from "@/db/sandboxes";
import { conversations, harnessCalls, harnessEvents, harnessRuns, machineRuns } from "@/db/schema";
import { listHostCommands } from "@/db/host-commands";
import { clipOutput } from "@/lib/agent/tools/bash";
import { resultFilePath } from "@/lib/chat/result-file";
import { openSandbox } from "@/lib/sandboxes/binding";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * 0013 Phase 6 — post-mortems from outside. Two chat tools, available
 * with or without a project, so looking at another chat or run never
 * requires joining its sandbox:
 *
 *   inspect       read-only: a chat's, run's, or stage visit's
 *                 transcript tail, harness activity, and sandbox binding
 *                 (the binding is the record of where calls ran — 0031).
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

function clip(text: string | null | undefined, limit: number): string {
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit)}… [${text.length - limit} chars clipped]`;
}

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
    tail: rows.slice(-TAIL_MESSAGES).map((m) => ({ role: m.role, at: m.at, text: clip(m.text, MESSAGE_CLIP) })),
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
      ...(e.input ? { input: clip(e.input, 300) } : {}),
      ...(e.output ? { output: clip(e.output, 500) } : {}),
      ...(e.text ? { text: clip(e.text, 300) } : {}),
    }));
  return { runs, recentEvents: events };
}

/**
 * 0040 phase 3: for a start_thread child, where its last result file
 * lives (it writes into its PARENT's sandbox, not its own — see
 * lib/chat/wake.ts / lib/chat/result-file.ts). There is no table of
 * result files, so this is derived, not looked up: the file a wake last
 * saved is named `<childId>-<wokenSettledAt>.md`, and `wokenSettledAt`
 * is stamped to exactly that same value right after writing it — so as
 * long as the child has not landed newer messages since, this IS that
 * file's real path. Not applicable (no fields) for a non-child; `null`
 * with a note when it cannot be derived cheaply (never settled a wake
 * yet, or the parent's sandbox is not bound) — never opens a sandbox.
 */
function childResultFileInfo(
  parentConversationId: string | null,
  childId: string,
  wokenSettledAt: number | null,
): { resultFile?: string | null; resultFileNote?: string } {
  if (!parentConversationId) return {};
  if (wokenSettledAt == null) return { resultFile: null, resultFileNote: "no settled wake yet" };
  const parentBinding = getConversationBinding(db(), parentConversationId);
  if (parentBinding?.kind !== "bound") {
    return { resultFile: null, resultFileNote: "parent sandbox not bound" };
  }
  return { resultFile: resultFilePath(parentBinding.workDir, `${childId}-${wokenSettledAt}`) };
}

/** 0043: the conversation's recent host-channel commands (audit trail). */
function hostActivity(conversationId: string) {
  const rows = listHostCommands(db(), conversationId, HOST_COMMANDS);
  if (rows.length === 0) return null;
  return rows.map((c) => ({
    host: c.hostName,
    command: clip(c.command, 400),
    exit: c.exitCode,
    ran: c.resolvedAt !== null,
    at: c.createdAt,
  }));
}

export type InspectResult = Record<string, unknown>;

/**
 * Inspect a conversation or run by id: `c_…` chat, `mr_…` run, or a
 * stage visit `mr_…_<seq>`. Read-only.
 */
export function inspectTarget(id: string): InspectResult {
  // 0022: a background harness call — status, its task, and where it runs.
  if (id.startsWith("hc_")) {
    const call = db().select().from(harnessCalls).where(eq(harnessCalls.id, id)).get();
    if (!call) return { kind: "error", code: "unknown-id", message: `no harness call "${id}"` };
    const binding = getConversationBinding(db(), call.conversationId);
    const events = harnessActivity(call.conversationId);
    // 0040 phase 3: a harness call has no separate "parent" — its result
    // file lives in its own conversation's sandbox, written only on a
    // completed settle (lib/chat/harness-step.ts); the path is reported
    // only when that binding is actually bound (never opens it here).
    const resultFile =
      call.status === "completed" && binding?.kind === "bound"
        ? resultFilePath(binding.workDir, call.id)
        : null;
    return {
      kind: "harness-call",
      id,
      harness: call.kind,
      status: call.status,
      task: clip(call.task, 1_000),
      ...(call.error ? { error: clip(call.error, 500) } : {}),
      ...(call.result ? { result: clip(call.result, 1_500) } : {}),
      ...(resultFile ? { resultFile } : {}),
      conversation: call.conversationId,
      eventsUrl: `/h/${call.kind}/${call.conversationId}`,
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
      wokenSettledAt: conversations.wokenSettledAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  if (!row) {
    // 0036-era fix (friction 2026-10-09): a HARNESS stage visit's session
    // id (mr_…_<seq>) has no conversation row, yet the run result's own
    // hint points here — serve the visit from its machine_stage_runs row.
    const visitId = /^mr_.+_(\d+)$/.exec(id);
    if (visitId) {
      const runId = id.replace(/_\d+$/, "");
      const visit = listStageRuns(db(), runId).find((v) => v.seq === Number(visitId[1]));
      if (visit) {
        return {
          kind: "visit",
          id,
          run: runId,
          stage: visit.stageId,
          status: visit.status,
          steps: visit.steps,
          ...(visit.outcome ? { outcome: clip(visit.outcome, 800) } : {}),
          ...(visit.error ? { error: clip(visit.error, 500) } : {}),
          ...(visit.route ? { route: visit.route } : {}),
          sandbox: sandboxSummary(getRunBinding(db(), runId)),
          harness: harnessActivity(id),
          eventsUrl: visit.harness ? `/h/${visit.harness}/${id}` : undefined,
        };
      }
    }
    // 2026-10-09 post-mortem: unknown ids are a VALUE, not a throw — a
    // typo'd id in a live turn retried 4x uselessly and killed the whole
    // wake turn; the model self-corrects on the shaped error.
    return { kind: "error", code: "unknown-id", message: `nothing to inspect: no chat or run "${id}"` };
  }

  if (row.kind === "run") {
    const run = db().select().from(machineRuns).where(eq(machineRuns.id, id)).get();
    if (!run) return { kind: "error", code: "unknown-id", message: `run ${id} has no run record` };
    const visits = listStageRuns(db(), id).map((v) => ({
      seq: v.seq,
      stage: v.stageId,
      kind: v.kind,
      ...(v.harness ? { harness: v.harness } : {}),
      status: v.status,
      ...(v.transitionTo ? { to: v.transitionTo } : {}),
      ...(v.outcome ? { outcome: clip(v.outcome, 800) } : {}),
      ...(v.error ? { error: clip(v.error, 500) } : {}),
      session: v.sessionId ?? `${id}_${v.seq}`,
    }));
    return {
      kind: "run",
      id,
      machine: run.machineName,
      status: run.status,
      ...(run.currentStage ? { currentStage: run.currentStage } : {}),
      ...(run.error ? { error: clip(run.error, 800) } : {}),
      prompt: clip(run.prompt, 1_000),
      projectId: run.projectId,
      sandbox: sandboxSummary(getRunBinding(db(), id)),
      visits,
      hint: "Inspect a visit's session id (mr_…_<seq>) for its transcript and harness activity.",
    };
  }

  const binding = getConversationBinding(db(), id);
  const base = {
    kind: row.kind,
    id,
    title: row.title,
    projectId: row.projectId,
    busy: Boolean(row.activeRunId),
    ...transcriptTail(id),
    harness: harnessActivity(id),
    hostCommands: hostActivity(id),
  };
  if (row.kind === "stage") {
    const runId = id.replace(/_\d+$/, "");
    return { ...base, run: runId, sandbox: sandboxSummary(getRunBinding(db(), runId)) };
  }
  return {
    ...base,
    sandbox:
      binding?.kind === "bound"
        ? sandboxSummary(binding)
        : { state: binding?.kind === "pending" ? "pending (created on first use)" : "none" },
    ...childResultFileInfo(row.parentConversationId, id, row.wokenSettledAt),
  };
}

/** Where a sandbox's owner works (the default directory for exec). */
function ownerWorkDir(sandboxId: string): string {
  const lease = getLease(db(), sandboxId);
  if (!lease) throw new Error(`no sandbox ${sandboxId}`);
  const holder =
    lease.ownerKind === "machine_run"
      ? getRunBinding(db(), lease.ownerId)
      : (() => {
          const b = getConversationBinding(db(), lease.ownerId);
          return b?.kind === "bound" ? b : null;
        })();
  return holder?.sandboxId === sandboxId ? holder.workDir : `/work/${lease.ownerId}`;
}

/**
 * Resolve what sandbox_exec targets: a sandbox id, or a chat / run /
 * stage visit id (its bound sandbox).
 */
export function resolveSandboxTarget(target: string): BoundSandbox {
  if (target.startsWith("sbx_")) {
    return { kind: "bound", sandboxId: target, workDir: ownerWorkDir(target), owner: false };
  }
  const runId = /^mr_.+_\d+$/.test(target) ? target.replace(/_\d+$/, "") : target;
  const kind = db()
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, runId))
    .get()?.kind;
  if (!kind) throw new Error(`no sandbox, chat, or run "${target}"`);
  const binding =
    kind === "run" ? getRunBinding(db(), runId) : (() => {
      const b = getConversationBinding(db(), runId);
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
