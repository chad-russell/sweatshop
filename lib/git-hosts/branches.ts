import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitCredential } from "@/db/schema";
import { GIT_HOSTS } from "@/lib/git-hosts/hosts";
import { httpsRemote, resolveCredential } from "@/lib/git-hosts/index";

const run = promisify(execFile);

/**
 * Branch names a remote has — for the New preview form. Asks the host
 * directly, authenticated through the remote's resolved GitHost
 * credential when one matches (private repos list too; the token rides
 * as a one-shot Authorization header, never written to disk). Failures
 * come back as a warning (the form falls back to a typed branch name)
 * instead of a silent empty list.
 */
export async function listRemoteBranches(
  remoteUrl: string,
  credentials: GitCredential[],
): Promise<{ branches: string[]; warning: string | null }> {
  const resolved = resolveCredential(remoteUrl, credentials, GIT_HOSTS);
  const auth =
    resolved &&
    `Authorization: Basic ${Buffer.from(
      `${resolved.credential.username}:${resolved.credential.secret}`,
    ).toString("base64")}`;
  try {
    const { stdout } = await run(
      "git",
      [...(auth ? ["-c", `http.extraheader=${auth}`] : []), "ls-remote", "--heads", httpsRemote(remoteUrl)],
      { timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    return {
      branches: stdout
        .split("\n")
        .map((l) => l.split("\trefs/heads/")[1]?.trim())
        .filter((b): b is string => Boolean(b))
        .sort(),
      warning: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    return { branches: [], warning: `couldn't list branches (${message}) — type the name instead` };
  }
}
