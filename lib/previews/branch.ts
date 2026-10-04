import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  getPreview,
  insertPreview,
  listBranchPreviews,
  newPreviewId,
  recordPreviewEvent,
  updatePreview,
  type Preview,
} from "@/db/previews";
import { getLease } from "@/db/sandboxes";
import { projectRepos } from "@/db/schema";
import { acquireSandbox, destroySandbox } from "@/lib/sandboxes/lease";
import { sandboxWorkRoot } from "@/lib/sandboxes/provision";
import { sandboxProvider, type SandboxHandle } from "@/lib/sandboxes/provider";
import { harnessPreviewNetwork } from "@/lib/previews/network";
import { processAlive, shellQuote } from "@/lib/previews/process";
import {
  deletePreview,
  inferPreviewCommand,
  launchPreview,
  PreviewError,
  projectPreviewDefaults,
  viewPreview,
  type PreviewDeps,
  type PreviewView,
} from "@/lib/previews/service";

/**
 * 0016 phase 3: branch previews. A branch preview owns a dedicated
 * sandbox (owner kind "preview", owner id = the preview id) with the
 * project's repos cloned and the followed repo checked out at the
 * branch. The FOLLOWER keeps it current: a deterministic loop, not an
 * agent — fetch; if the remote moved, fast-forward (hard reset on a
 * force-push: the preview owns no local work), reinstall + restart only
 * when dependencies changed, otherwise trust the dev server's reload.
 * Failures park the preview as `failed` with the log and raise an Inbox
 * item keyed by the failing sha; nothing escalates to a model on its own.
 */

export interface CreateBranchPreviewInput {
  projectId: string;
  repoId: string;
  branch: string;
  command?: string;
  port?: number;
  label?: string;
}

/** Marker failedSha for a preview that never got as far as a commit. */
export const CREATE_FAILED = "create";

async function sh(handle: SandboxHandle, command: string, cwd: string): Promise<{ ok: boolean; out: string }> {
  const r = await handle.run(command, { GIT_TERMINAL_PROMPT: "0" }, cwd);
  return { ok: r.exitCode === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

function lastLine(text: string): string {
  return text.split("\n").pop()?.trim() ?? "";
}

/**
 * Branch names a remote has — for the New preview form. Asks the host
 * directly (works for public remotes and hosts this process can reach);
 * an empty list just means "type the branch name".
 */
export async function listRemoteBranches(repoId: string): Promise<string[]> {
  const repo = db().select().from(projectRepos).where(eq(projectRepos.id, repoId)).get();
  if (!repo) throw new PreviewError("not-found", `no repo ${repoId}`);
  const [{ execFile }, { promisify }, { httpsRemote }] = await Promise.all([
    import("node:child_process"),
    import("node:util"),
    import("@/lib/git-hosts/index"),
  ]);
  try {
    const { stdout } = await promisify(execFile)("git", ["ls-remote", "--heads", httpsRemote(repo.url)], {
      timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout
      .split("\n")
      .map((l) => l.split("\trefs/heads/")[1]?.trim())
      .filter((b): b is string => Boolean(b))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Create a branch preview: a dedicated sandbox (named by the pre-minted
 * preview id), the row, checkout, launch. A failure after the row exists
 * leaves the preview `failed` with the reason — visible and retryable,
 * never a half-made invisible thing.
 */
export async function createBranchPreview(
  input: CreateBranchPreviewInput,
  deps: PreviewDeps = {},
): Promise<{ preview: PreviewView; log?: string }> {
  const provider = deps.provider ?? sandboxProvider();
  const repo = db().select().from(projectRepos).where(eq(projectRepos.id, input.repoId)).get();
  if (!repo || repo.projectId !== input.projectId) {
    throw new PreviewError("invalid", `repo ${input.repoId} is not in project ${input.projectId}`);
  }
  const branch = input.branch.trim();
  if (!/^[\w./-]{1,200}$/.test(branch) || branch.includes("..") || branch.startsWith("-")) {
    throw new PreviewError("invalid", `not a branch name: ${input.branch}`);
  }

  const id = newPreviewId();
  const root = sandboxWorkRoot(id);
  const { sandboxId, handle } = await acquireSandbox(
    { mode: "dedicated", ownerKind: "preview", ownerId: id, projectId: input.projectId, root },
    provider,
  );
  const dir = `${root}/${repo.name}`;
  insertPreview(db(), {
    id,
    sandboxId,
    workDir: dir,
    command: input.command ?? "true",
    port: input.port ?? 3000,
    label: input.label?.trim() || branch,
    source: "branch",
    repoId: repo.id,
    branch,
    startedBy: "user",
  });

  try {
    const co = await sh(
      handle,
      `git fetch --quiet origin ${shellQuote(branch)} && git checkout --quiet -B ${shellQuote(branch)} FETCH_HEAD && git rev-parse HEAD`,
      dir,
    );
    if (!co.ok) throw new Error(`checkout ${branch}: ${co.out}`);
    const sha = lastLine(co.out);
    const defaults = projectPreviewDefaults(input.projectId);
    let command = input.command ?? defaults.command ?? undefined;
    let port = input.port ?? defaults.port ?? undefined;
    if (!command) {
      const inferred = await inferPreviewCommand(handle, dir);
      if ("error" in inferred) throw new Error(inferred.error);
      command = inferred.command;
      port ??= inferred.port;
    }
    updatePreview(db(), id, { command, port: port ?? 3000, headSha: sha });
    const launched = await launchPreview(id, deps);
    recordPreviewEvent(db(), {
      previewId: id,
      sha,
      result: launched.preview.status === "healthy" ? "deployed" : "failed",
      detail: "created",
    });
    if (launched.preview.status !== "healthy") {
      updatePreview(db(), id, {
        status: "failed",
        failedSha: sha,
        error: launched.preview.error ?? "the server did not come up",
      });
      return { preview: viewPreview(getPreview(db(), id)!), ...(launched.log ? { log: launched.log } : {}) };
    }
    return launched;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updatePreview(db(), id, { status: "failed", error: message, failedSha: CREATE_FAILED });
    recordPreviewEvent(db(), { previewId: id, sha: CREATE_FAILED, result: "failed", detail: message });
    return { preview: viewPreview(getPreview(db(), id)!) };
  }
}

/**
 * Deleting a preview. A worktree preview only stops — its sandbox
 * belongs to the chat or run. A preview-owned sandbox (branch previews)
 * exists only to serve it, so it is destroyed with it.
 */
export async function removePreview(id: string, deps: PreviewDeps = {}): Promise<void> {
  const p = getPreview(db(), id);
  if (!p) return;
  await deletePreview(id, deps);
  const lease = getLease(db(), p.sandboxId);
  if (lease?.ownerKind === "preview" && lease.status !== "destroyed") {
    await destroySandbox(lease.id, deps.provider);
  }
}

// ── the follower ────────────────────────────────────────────────────────

export interface FollowReport {
  previewId: string;
  action: "unchanged" | "deployed" | "reloaded" | "failed" | "skipped";
  sha?: string;
  detail?: string;
}

const DEP_FILE = /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.nvmrc|\.node-version)$/;

/** The install command for a checkout, by lockfile. */
export function installCommand(files: string): string {
  if (/^pnpm-lock\.yaml$/m.test(files)) return "pnpm install";
  if (/^yarn\.lock$/m.test(files)) return "yarn install";
  if (/^bun\.lockb?$/m.test(files)) return "bun install";
  return "npm install";
}

/** Does the preview command run its own install (so a restart reinstalls)? */
export function commandInstalls(command: string): boolean {
  return /\b(npm|pnpm|yarn|bun)\s+(install|i|ci)\b/.test(command);
}

/** Did any of these changed paths touch dependencies? */
export function dependenciesChanged(changedPaths: string): boolean {
  return changedPaths
    .split("\n")
    .map((f) => f.trim().split("/").pop() ?? "")
    .some((name) => DEP_FILE.test(name));
}

/**
 * Advance one branch preview to its remote head. Idempotent per sha: an
 * unchanged remote is a no-op, and a sha that already failed is not
 * retried until the branch moves again (or Chad hits Retry).
 */
export async function followPreview(p: Preview, deps: PreviewDeps = {}): Promise<FollowReport> {
  const provider = deps.provider ?? sandboxProvider();
  const network = deps.network ?? harnessPreviewNetwork;
  const base = { previewId: p.id };
  if (p.source !== "branch" || !p.branch || p.deletedAt) return { ...base, action: "skipped" };
  // A stopped preview (idle-reaped, or stopped by hand) is not followed
  // — following would resume its sandbox for nobody.
  if (p.status === "stopped") return { ...base, action: "skipped", detail: "stopped" };
  const lease = getLease(db(), p.sandboxId);
  if (lease?.status !== "running") return { ...base, action: "skipped", detail: `sandbox ${lease?.status ?? "missing"}` };
  const handle = provider.attach(lease.ref, p.workDir);
  const dir = p.workDir;

  const fetched = await sh(handle, `git fetch --quiet origin ${shellQuote(p.branch)} && git rev-parse FETCH_HEAD`, dir);
  if (!fetched.ok) {
    // A network blip should not page Chad: report it, change nothing.
    return { ...base, action: "skipped", detail: `fetch: ${fetched.out.slice(-300)}` };
  }
  const remote = lastLine(fetched.out);
  if (remote === p.headSha && p.status !== "failed") return { ...base, action: "unchanged", sha: remote };
  if (remote === p.failedSha) return { ...base, action: "unchanged", sha: remote, detail: "known failure" };

  const fail = (detail: string): FollowReport => {
    updatePreview(db(), p.id, { status: "failed", error: detail, failedSha: remote });
    recordPreviewEvent(db(), { previewId: p.id, sha: remote, result: "failed", detail });
    return { ...base, action: "failed", sha: remote, detail };
  };

  // What changed (for the dependency check) — unknown history counts as
  // "everything" — then move: fast-forward when possible, hard reset
  // when the branch was rewritten.
  const diff = p.headSha
    ? await sh(handle, `git diff --name-only ${shellQuote(p.headSha)} ${shellQuote(remote)}`, dir)
    : { ok: false, out: "" };
  const ff = await sh(handle, `git merge --ff-only --quiet ${shellQuote(remote)}`, dir);
  let reset = false;
  if (!ff.ok) {
    const hard = await sh(handle, `git reset --hard --quiet ${shellQuote(remote)} && git clean -fdq -e node_modules`, dir);
    if (!hard.ok) return fail(`could not move to ${remote.slice(0, 7)}: ${hard.out}`);
    reset = true;
  }

  const depsChanged = !diff.ok || dependenciesChanged(diff.out);
  const alive = await processAlive(handle, p.id);
  if (depsChanged || !alive || p.status === "failed") {
    // Reinstall up front only when the command does not install for
    // itself and the checkout root is the package (a command like
    // `cd app && npm install && …` owns its install; the restart reruns it).
    if (depsChanged && !commandInstalls(p.command)) {
      const files = await sh(handle, "ls -1a", dir);
      if (/^package\.json$/m.test(files.out)) {
        const install = await sh(handle, `set -o pipefail; ${installCommand(files.out)} 2>&1 | tail -60`, dir);
        if (!install.ok) return fail(`install failed at ${remote.slice(0, 7)}:\n${install.out}`);
      }
    }
    const launched = await launchPreview(p.id, { ...deps, provider, network }).catch(
      (err: unknown) => ({ preview: null, log: err instanceof Error ? err.message : String(err) }),
    );
    if (!launched.preview || launched.preview.status !== "healthy") {
      return fail(`the server did not come up at ${remote.slice(0, 7)}:\n${launched.log ?? ""}`);
    }
    updatePreview(db(), p.id, { headSha: remote, failedSha: null, error: null });
    recordPreviewEvent(db(), {
      previewId: p.id,
      sha: remote,
      result: reset ? "reset" : "deployed",
      detail: depsChanged ? "dependencies changed — reinstalled and restarted" : "restarted",
    });
    return { ...base, action: "deployed", sha: remote };
  }

  // Source-only change: the dev server reloads by itself. A server that
  // died on the new code is a failure; one still answering is fine.
  if (!(await network.probe(lease.ref, p.port)) && !(await processAlive(handle, p.id))) {
    return fail(`the server exited after ${remote.slice(0, 7)}`);
  }
  updatePreview(db(), p.id, { headSha: remote, failedSha: null, error: null, status: "healthy" });
  recordPreviewEvent(db(), { previewId: p.id, sha: remote, result: reset ? "reset" : "reloaded" });
  return { ...base, action: "reloaded", sha: remote };
}

/** One follow pass over every branch preview (the tick calls this). */
export async function followBranchPreviews(deps: PreviewDeps = {}): Promise<FollowReport[]> {
  const reports: FollowReport[] = [];
  for (const p of listBranchPreviews(db())) {
    try {
      reports.push(await followPreview(p, deps));
    } catch (err) {
      reports.push({ previewId: p.id, action: "skipped", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return reports;
}

/**
 * Retry (Inbox / previews page): forget the failure and deploy whatever
 * the remote has now. A worktree preview just relaunches.
 */
export async function retryPreview(id: string, deps: PreviewDeps = {}): Promise<FollowReport> {
  const p = getPreview(db(), id);
  if (!p || p.deletedAt) throw new PreviewError("not-found", `no preview ${id}`);
  if (p.source !== "branch") {
    const { preview } = await launchPreview(id, deps);
    return { previewId: id, action: preview.status === "healthy" ? "deployed" : "failed" };
  }
  // Forget the failure; headSha null makes the follower treat it as a
  // full deploy (install + restart) of the remote head. A preview whose
  // create failed before checkout gets its branch fetched the same way —
  // the clone exists (the sandbox was provisioned with the project).
  updatePreview(db(), id, { failedSha: null, headSha: null, status: "failed", error: null });
  return followPreview(getPreview(db(), id)!, deps);
}

/** Dismiss: hide this failing sha's Inbox item (a new failure shows again). */
export function dismissPreviewFailure(id: string): void {
  const p = getPreview(db(), id);
  if (!p) throw new PreviewError("not-found", `no preview ${id}`);
  updatePreview(db(), id, { dismissedSha: p.failedSha });
}
