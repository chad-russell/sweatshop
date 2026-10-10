import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { getConversation, listModelMessages } from "@/db/chat";
import { getProject } from "@/db/projects";
import { getConversationBinding } from "@/db/sandboxes";
import { harnessEvents } from "@/db/schema";
import { openConversationSandbox } from "@/lib/sandboxes/binding";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * 0037 phase 1: the evidence a gated tool's approval card carries, built
 * by the RUNTIME — not the model — so a skipped step is visible before
 * Chad approves. Two parts:
 *
 * - screenshots: every successful `attach_screenshot` in the thread —
 *   the conversation's own tool results (chat or agent stage) plus its
 *   background harness calls' events (`harness_events` keyed by the
 *   conversation id). Replaces the machines-only `collectRunEvidence`
 *   for threads.
 * - a check: the project's test command, run by the runtime in the
 *   repo the PR is for, capped and tailed.
 */

export interface EvidenceShot {
  url: string;
  label?: string;
}

export interface CheckResult {
  /** The command as configured on the project. */
  command: string;
  status: "passed" | "failed" | "timed-out" | "error";
  exitCode: number | null;
  /** Last lines of combined output. */
  tail: string;
  durationMs: number;
}

export interface ApprovalEvidence {
  screenshots: EvidenceShot[];
  /** null = the project has no test command (the card says so). */
  check: CheckResult | null;
  /** Why the check could not run, when it could not (no sandbox, …). */
  checkNote?: string;
}

type Part = { type?: string; toolName?: string; input?: unknown; output?: unknown };

function okUrl(value: unknown): string | null {
  const v = value as { ok?: unknown; url?: unknown } | null | undefined;
  return v && v.ok === true && typeof v.url === "string" ? v.url : null;
}

/** Screenshots attached anywhere in this thread, oldest first. */
export function collectThreadEvidence(conversationId: string): EvidenceShot[] {
  const labels = new Map<string, string>();
  const shots: EvidenceShot[] = [];
  const seen = new Set<string>();
  const push = (url: string, label?: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    shots.push(label ? { url, label } : { url });
  };

  for (const message of listModelMessages(db(), conversationId)) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Part[]) {
      if (part.toolName !== "attach_screenshot") continue;
      const id = (part as { toolCallId?: string }).toolCallId ?? "";
      if (part.type === "tool-call") {
        const label = (part.input as { label?: unknown } | undefined)?.label;
        if (typeof label === "string" && label) labels.set(id, label);
      } else if (part.type === "tool-result") {
        // ModelMessage tool results wrap the value: { type: "json", value }.
        const output = part.output as { type?: string; value?: unknown } | undefined;
        const url = okUrl(output?.type === "json" ? output.value : output);
        if (url) push(url, labels.get(id));
      }
    }
  }

  const rows = db()
    .select({ input: harnessEvents.input, output: harnessEvents.output, kind: harnessEvents.kind, toolCallId: harnessEvents.toolCallId })
    .from(harnessEvents)
    .where(
      and(
        eq(harnessEvents.sessionId, conversationId),
        eq(harnessEvents.toolName, "attach_screenshot"),
        inArray(harnessEvents.kind, ["tool-start", "tool-end"]),
      ),
    )
    .all();
  const harnessLabels = new Map<string, string>();
  for (const row of rows) {
    try {
      if (row.kind === "tool-start") {
        const label = (JSON.parse(row.input ?? "") as { label?: unknown }).label;
        if (typeof label === "string" && label && row.toolCallId) harnessLabels.set(row.toolCallId, label);
        continue;
      }
      const url = okUrl(JSON.parse(row.output ?? ""));
      if (url) push(url, row.toolCallId ? harnessLabels.get(row.toolCallId) : undefined);
    } catch {
      // clipped or non-JSON payload — skip
    }
  }
  return shots;
}

/** Hard cap on a gate's check — gpl's install+tsc+vitest is minutes. */
export const CHECK_TIMEOUT_SECONDS = 900;
const TAIL_LINES = 25;

type Run = (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

function tail(text: string, lines: number): string {
  const all = text.trimEnd().split("\n");
  return all.slice(-lines).join("\n").slice(-4_000);
}

/** Run the project's test command in `repoDir` through `run`. Pure over
 *  the runner (tests pass a fake). */
export async function runCheck(run: Run, command: string, repoDir: string): Promise<CheckResult> {
  const started = Date.now();
  const quotedDir = `'${repoDir.replace(/'/g, `'\\''`)}'`;
  const quotedCmd = `'${command.replace(/'/g, `'\\''`)}'`;
  try {
    // `timeout` exits 124 on expiry; stderr folds into stdout so the
    // tail is in the order it printed.
    const res = await run(`cd ${quotedDir} && timeout ${CHECK_TIMEOUT_SECONDS} bash -lc ${quotedCmd} 2>&1`);
    const durationMs = Date.now() - started;
    const out = tail(`${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`, TAIL_LINES);
    return {
      command,
      status: res.exitCode === 0 ? "passed" : res.exitCode === 124 ? "timed-out" : "failed",
      exitCode: res.exitCode,
      tail: out,
      durationMs,
    };
  } catch (err) {
    return {
      command,
      status: "error",
      exitCode: null,
      tail: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}

/**
 * The full card evidence for a PR on `repo` in this conversation:
 * screenshots always; the check when the project has a test command and
 * the conversation has a BOUND sandbox (a pending one would provision a
 * sandbox just to test — never in an approval preview).
 */
export async function buildApprovalEvidence(
  conversationId: string,
  repo: string,
  provider?: SandboxProvider,
): Promise<ApprovalEvidence> {
  const screenshots = collectThreadEvidence(conversationId);
  const projectId = getConversation(db(), conversationId)?.projectId;
  const command = projectId ? (getProject(db(), projectId)?.testCommand ?? null) : null;
  if (!command) return { screenshots, check: null };
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) {
    return { screenshots, check: null, checkNote: `unusual repo name "${repo}" — check skipped` };
  }
  const binding = getConversationBinding(db(), conversationId);
  if (!binding || binding.kind !== "bound") {
    return { screenshots, check: null, checkNote: "no sandbox bound — the test command did not run" };
  }
  try {
    const opened = await openConversationSandbox(conversationId, provider);
    const check = await runCheck((cmd) => opened.handle.run(cmd, undefined, opened.workDir), command, repo);
    return { screenshots, check };
  } catch (err) {
    return {
      screenshots,
      check: null,
      checkNote: `sandbox unavailable — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** One line for the model's tool result / card text. */
export function describeCheck(evidence: ApprovalEvidence): string {
  const c = evidence.check;
  if (!c) return evidence.checkNote ?? "no test command set on the project";
  const secs = Math.round(c.durationMs / 1000);
  return `tests ${c.status}${c.exitCode !== null ? ` (exit ${c.exitCode})` : ""} in ${secs}s — \`${c.command}\``;
}
