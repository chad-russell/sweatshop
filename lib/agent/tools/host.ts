import { db } from "@/db";
import { getConversation } from "@/db/chat";
import { getProjectHostByName, listProjectHosts, parseAddress, setHostKeyFingerprint } from "@/db/hosts";
import { recordHostCommand, resolveHostCommand } from "@/db/host-commands";
import { resolveHostCredential } from "@/lib/hosts/credentials";
import { ssh2Transport, type HostExecOutcome, type HostTransport } from "@/lib/hosts/transport";
import { clipEnds as clipOutput } from "@/lib/clip";

/**
 * 0043: the `exec` tool's core. Two halves, both plain functions on the
 * bash-tool pattern — the workflow steps are thin wrappers and tests
 * inject a fake transport here.
 *
 * `hostExecPreview` validates WITHOUT connecting (unknown host, missing
 * credential) so Chad never approves an exec that cannot run; it builds
 * the approval card text. `hostExecRun` runs after his approval: it
 * writes the pending audit row, executes over the transport, resolves
 * the row with the clipped combined output, and pins the host key on a
 * first connect (TOFU). Every failure is value-shaped so the model can
 * repair its call.
 */

export const DEFAULT_TIMEOUT_SEC = 120;
export const MAX_TIMEOUT_SEC = 900;

/** The tool's serialized input. */
export interface HostExecInput {
  host: string;
  command: string;
  timeout?: number;
}

/** Combined clip for the audit row (the doc's 60 k limit). */
const AUDIT_CLIP = 60_000;

export type HostExecPreview =
  | {
      ok: true;
      summary: string;
      host: { id: string; name: string; address: string; user: string; apiBase: string | null };
      timeoutSec: number;
      command: string;
    }
  | { ok: false; code: "no-project" | "unknown-host" | "no-credential" | "bad-command"; message: string; hosts?: string[] };

function projectOf(conversationId: string): string | null {
  return getConversation(db(), conversationId)?.projectId ?? null;
}

function clampTimeout(timeout: number | undefined): number {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.min(Math.ceil(timeout), MAX_TIMEOUT_SEC);
}

export function hostExecPreview(conversationId: string, input: HostExecInput): HostExecPreview {
  const projectId = projectOf(conversationId);
  if (!projectId) return { ok: false, code: "no-project", message: "This conversation has no project — hosts are per-project." };
  const command = input.command?.trim() ?? "";
  if (!command) return { ok: false, code: "bad-command", message: "A command is required." };
  if (command.length > 20_000) return { ok: false, code: "bad-command", message: "Command too long (20 k characters max)." };
  const names = listProjectHosts(db(), projectId).map((h) => h.name);
  const host = getProjectHostByName(db(), projectId, input.host.trim().toLowerCase());
  if (!host) {
    return {
      ok: false,
      code: "unknown-host",
      message: names.length
        ? `"${input.host}" is not on this project's host list. Hosts: ${names.join(", ")}.`
        : "This project has no hosts on its allow-list.",
      hosts: names,
    };
  }
  const credential = resolveHostCredential(host.name);
  if (!credential.ok) {
    return {
      ok: false,
      code: "no-credential",
      message: `${credential.message} (add it to the app's environment, then retry — the service must restart to pick it up).`,
      hosts: names,
    };
  }
  const timeoutSec = clampTimeout(input.timeout);
  return {
    ok: true,
    summary: `exec on ${host.name} — ${host.user}@${host.address} (${timeoutSec}s timeout)\n\n$ ${command}`,
    host: { id: host.id, name: host.name, address: host.address, user: host.user, apiBase: host.apiBase },
    timeoutSec,
    command,
  };
}

export type HostExecRun =
  | {
      ok: true;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      durationMs: number;
      /** First connect pinned this fingerprint (TOFU — noted in the audit row). */
      pinned?: string;
      /** 0043 amendment: ran without asking (the chat's auto-approve
       *  toggle) — the exec card's "auto-approved" chip reads this. */
      autoApproved?: boolean;
    }
  | {
      ok: false;
      code: "no-project" | "bad-command" | "unknown-host" | "no-credential" | "connect-failed" | "host-key-changed" | "timeout";
      message: string;
      stdout?: string;
      stderr?: string;
    };

export async function hostExecRun(
  conversationId: string,
  input: HostExecInput,
  transport: HostTransport = ssh2Transport,
  /** 0043 amendment: this call skipped ask_chad under the chat's
   *  auto-approve toggle — recorded on the audit row as-is. */
  autoApproved = false,
): Promise<HostExecRun> {
  // Re-validate: approval took time and the registry may have moved.
  const preview = hostExecPreview(conversationId, input);
  if (!preview.ok) {
    return { ok: false, code: preview.code, message: preview.message };
  }
  const address = parseAddress(preview.host.address);
  if (!address) return { ok: false, code: "connect-failed", message: `invalid stored address "${preview.host.address}"` };
  const host = getProjectHostByName(db(), projectOf(conversationId)!, preview.host.name)!;
  const credential = resolveHostCredential(host.name);
  if (!credential.ok) return { ok: false, code: "no-credential", message: credential.message };

  const id = `hx_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  recordHostCommand(db(), { id, conversationId, hostId: host.id, hostName: host.name, command: preview.command, autoApproved });

  let outcome: HostExecOutcome;
  try {
    outcome = await transport.exec({
      hostId: host.id,
      host: address.host,
      port: address.port,
      username: host.user,
      credential: credential.credential,
      command: preview.command,
      timeoutMs: preview.timeoutSec * 1000,
      expectedFingerprint: host.hostKeyFp,
    });
  } catch (err) {
    outcome = { ok: false, code: "connect-failed", message: err instanceof Error ? err.message : String(err) };
  }

  if (!outcome.ok) {
    resolveHostCommand(db(), id, { exitCode: null, output: clipOutput(outcome.message, AUDIT_CLIP), durationMs: 0 });
    return { ok: false, code: outcome.code, message: outcome.message };
  }
  const { result } = outcome;
  if (result.pinnedFingerprint) setHostKeyFingerprint(db(), host.id, result.pinnedFingerprint);

  const note = result.pinnedFingerprint
    ? `[first connect — host key pinned ${result.pinnedFingerprint.slice(0, 23)}…]\n`
    : "";
  const combined = clipOutput(`${note}exit ${result.exitCode ?? "?"}${result.timedOut ? " (timed out)" : ""}\n${result.stdout}\n${result.stderr}`, AUDIT_CLIP);
  resolveHostCommand(db(), id, {
    exitCode: result.exitCode,
    output: combined,
    durationMs: result.durationMs,
  });

  if (result.timedOut) {
    return {
      ok: false,
      code: "timeout",
      message: `timed out after ${preview.timeoutSec}s (partial output below; the command may still be running on ${host.name} — check before repeating it)`,
      stdout: clipOutput(result.stdout, AUDIT_CLIP),
      stderr: clipOutput(result.stderr, AUDIT_CLIP),
    };
  }
  return {
    ok: true,
    exitCode: result.exitCode,
    stdout: clipOutput(result.stdout, AUDIT_CLIP),
    stderr: clipOutput(result.stderr, AUDIT_CLIP),
    durationMs: result.durationMs,
    ...(result.pinnedFingerprint ? { pinned: result.pinnedFingerprint } : {}),
    ...(autoApproved ? { autoApproved: true } : {}),
  };
}
