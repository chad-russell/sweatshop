import { execFile } from "node:child_process";
import { db } from "@/db";
import { listGitCredentials } from "@/db/projects";

/**
 * 0033 Phase A: the gh core — the real GitHub CLI, run in the app
 * container with the stored github credential's token as GH_TOKEN
 * (verified live 2026-10-08: the existing token sees private
 * TangoGroup repos). The credential policy in one line: the agent
 * never touches secret material — it exercises a capability that is
 * credentialed on its behalf. Read-only allowlist of command paths;
 * argv array, never a shell; output clipped; the token never appears
 * in a result (and is scrubbed defensively if something echoes it).
 */

/** Read-only command paths (gh api is excluded — it can POST). */
const ALLOWED = new Set([
  "repo list",
  "repo view",
  "search repos",
  "search code",
  "search issues",
  "search prs",
  "search commits",
  "org list",
  "pr list",
  "pr view",
  "pr checks",
  "pr diff",
  "issue list",
  "issue view",
  "release list",
  "release view",
]);

const ALLOWED_LIST = [...ALLOWED].sort();

const TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 20_000;

export type GhResult =
  | { ok: true; command: string; output: string }
  | { ok: false; code: string; message: string; allowed: string[] };

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… [clipped at ${max} characters]` : s;
}

export function allowedGhCommands(): string[] {
  return ALLOWED_LIST;
}

export async function runGh(rawArgs: string[]): Promise<GhResult> {
  const args = rawArgs.map((a) => a.trim()).filter((a) => a.length > 0);
  if (args.length === 0) {
    return { ok: false, code: "bad-args", message: "No gh subcommand given.", allowed: ALLOWED_LIST };
  }
  const commandPath = args.slice(0, 2).join(" ");
  if (!ALLOWED.has(commandPath)) {
    return {
      ok: false,
      code: "not-allowed",
      message: `"${commandPath}" is not on the read-only allowlist (gh api is excluded — it can mutate).`,
      allowed: ALLOWED_LIST,
    };
  }

  const credential = listGitCredentials(db()).find((c: { kind: string }) => c.kind === "github");
  if (!credential) {
    return {
      ok: false,
      code: "not-configured",
      message: "No github credential is stored on this server, so gh cannot authenticate.",
      allowed: ALLOWED_LIST,
    };
  }

  return new Promise<GhResult>((resolve) => {
    execFile(
      "gh",
      args,
      {
        env: {
          ...process.env,
          GH_TOKEN: credential.secret,
          GH_NO_UPDATE_NOTIFIER: "1",
          GH_PROMPT_DISABLED: "1",
        },
        timeout: TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            resolve({
              ok: false,
              code: "gh-not-installed",
              message: "The gh CLI is not installed in the app image.",
              allowed: ALLOWED_LIST,
            });
            return;
          }
          const detail = String(stderr || stdout || err.message).split(credential.secret).join("***");
          resolve({
            ok: false,
            code: "gh-failed",
            message: `gh exited ${(err as { code?: number }).code ?? "?"}: ${clip(detail, 500)}`,
            allowed: ALLOWED_LIST,
          });
          return;
        }
        const out = `${stdout}${stderr ? `\n${stderr}` : ""}`
          .trim()
          .split(credential.secret)
          .join("***");
        resolve({ ok: true, command: `gh ${args.join(" ")}`, output: clip(out, MAX_OUTPUT) });
      },
    );
  });
}
