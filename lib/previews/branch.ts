import { eq } from "drizzle-orm";
import { db } from "@/db";
import { getPreviewSetupDefinition, savePreviewSetup } from "@/db/preview-setups";
import {
  getPreview,
  insertPreview,
  listBranchPreviews,
  markPreviewDeleted,
  newPreviewId,
  recordPreviewEvent,
  updatePreview,
  type Preview,
} from "@/db/previews";
import { getLease, markDestroyed } from "@/db/sandboxes";
import { gitCredentials, projectRepos } from "@/db/schema";
import { activateDedicatedLease, destroySandbox, mintDedicatedLease } from "@/lib/sandboxes/lease";
import { sandboxWorkRoot } from "@/lib/sandboxes/provision";
import { sandboxProvider, type SandboxHandle } from "@/lib/sandboxes/provider";
import { harnessPreviewNetwork } from "@/lib/previews/network";
import { processAlive, shellQuote } from "@/lib/previews/process";
import { discoverPreviewCandidates, type PreviewCandidate } from "@/lib/previews/discover";
import type { PreviewSetupDefinition } from "@/lib/previews/setup";
import {
  launchPreview,
  deletePreview,
  PreviewError,
  viewPreview,
  type PreviewDeps,
  type PreviewView,
} from "@/lib/previews/service";

/**
 * 0017 phase 1: branch previews, reworked around the preview setup.
 * Creation splits into PROVISION (row first, so failures are visible
 * failed previews — never invisible 500s; sandbox + clone + checkout)
 * → DISCOVER (scan the checkout for candidates — no saved setup yet) →
 * CONFIRM (values + optional setup save, install at the repo root,
 * launch — install is not part of the server command). The follower
 * reinstalls from the setup's `install`, not a lockfile guess.
 */

export interface CreateBranchPreviewInput {
  projectId: string;
  repoId: string;
  branch: string;
  command?: string;
  port?: number;
  install?: string;
  workDir?: string;
  label?: string;
  /** Sparse per-preview env overrides (0017 phase 2). */
  env?: Record<string, string>;
  /** Save the resolved values as the project's setup (Discover flow). */
  saveSetup?: boolean;
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

/** Repo + project context derived from a preview row (confirm/follow). */
interface PreviewContext {
  projectId: string;
  repoRoot: string;
}

function previewContext(p: Preview): PreviewContext | null {
  if (!p.repoId) return null;
  const repo = db().select().from(projectRepos).where(eq(projectRepos.id, p.repoId)).get();
  const lease = getLease(db(), p.sandboxId);
  if (!repo || !lease) return null;
  return { projectId: repo.projectId, repoRoot: `${sandboxWorkRoot(lease.ownerId)}/${repo.name}` };
}

/** The project's saved setup for a preview's repo, if any. */
function setupFor(p: Preview): PreviewSetupDefinition | null {
  const ctx = previewContext(p);
  return ctx ? getPreviewSetupDefinition(db(), ctx.projectId) : null;
}

// ── provision / discover / confirm ──────────────────────────────────────

/**
 * Branch names a remote has — for the New preview form. Asks the host
 * directly, authenticated through the repo's resolved GitHost
 * credential when one matches (private repos list too; the token rides
 * as a one-shot Authorization header, never written to disk). Failures
 * come back as a warning (the form falls back to a typed branch name)
 * instead of a silent empty list.
 */
export async function listRemoteBranches(
  repoId: string,
): Promise<{ branches: string[]; warning: string | null }> {
  const repo = db().select().from(projectRepos).where(eq(projectRepos.id, repoId)).get();
  if (!repo) return { branches: [], warning: `no repo ${repoId}` };
  const [{ execFile }, { promisify }, gitHosts, index] = await Promise.all([
    import("node:child_process"),
    import("node:util"),
    import("@/lib/git-hosts/hosts"),
    import("@/lib/git-hosts/index"),
  ]);
  const credentials = db().select().from(gitCredentials).all();
  const resolved = index.resolveCredential(repo.url, credentials, gitHosts.GIT_HOSTS);
  const auth =
    resolved &&
    `Authorization: Basic ${Buffer.from(
      `${resolved.credential.username}:${resolved.credential.secret}`,
    ).toString("base64")}`;
  try {
    const { stdout } = await promisify(execFile)(
      "git",
      [
        ...(auth ? ["-c", `http.extraheader=${auth}`] : []),
        "ls-remote",
        "--heads",
        index.httpsRemote(repo.url),
      ],
      {
        timeout: 15_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
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

export interface ProvisionResult {
  preview: PreviewView;
  /** Present when provisioning succeeded (row status `provisioning`). */
  ready?: { repoRoot: string; sha: string };
}

/**
 * Provision a branch preview: mint the lease, INSERT THE PREVIEW ROW
 * (status `provisioning` — it exists before anything can fail), create
 * the sandbox (the provider clones the project's repos), check out the
 * branch. Any failure parks the preview `failed`, records the event,
 * and destroys the half-made lease — never an invisible throw.
 */
export async function provisionBranchPreview(
  input: CreateBranchPreviewInput,
  deps: PreviewDeps = {},
): Promise<ProvisionResult> {
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
  const setup = getPreviewSetupDefinition(db(), input.projectId);
  const sandboxId = mintDedicatedLease(
    { mode: "dedicated", ownerKind: "preview", ownerId: id, projectId: input.projectId, root },
    provider,
  );
  insertPreview(db(), {
    id,
    sandboxId,
    workDir: `${root}/${repo.name}`,
    command: input.command ?? setup?.command ?? "true",
    port: input.port ?? setup?.port ?? 3000,
    label: input.label?.trim() || branch,
    source: "branch",
    repoId: repo.id,
    branch,
    startedBy: "user",
    status: "provisioning",
  });

  const fail = (message: string): ProvisionResult => {
    updatePreview(db(), id, { status: "failed", error: message, failedSha: CREATE_FAILED });
    recordPreviewEvent(db(), { previewId: id, sha: CREATE_FAILED, result: "failed", detail: message });
    // The half-made lease must not outlive the attempt: a provisioned
    // one is destroyed outright; a never-provisioned one is marked
    // destroyed (the preview row's FK keeps it as history).
    const lease = getLease(db(), sandboxId);
    if (lease && lease.status !== "destroyed") {
      if (lease.status === "running") {
        void destroySandbox(lease.id, provider).catch(() => undefined);
      } else {
        markDestroyed(db(), lease.id);
      }
    }
    return { preview: viewPreview(getPreview(db(), id)!) };
  };

  try {
    const handle = await activateDedicatedLease(
      { mode: "dedicated", ownerKind: "preview", ownerId: id, projectId: input.projectId, root, sandboxId },
      provider,
    );
    const repoRoot = `${root}/${repo.name}`;
    const co = await sh(
      handle,
      `git fetch --quiet origin ${shellQuote(branch)} && git checkout --quiet -B ${shellQuote(branch)} FETCH_HEAD && git rev-parse HEAD`,
      repoRoot,
    );
    if (!co.ok) return fail(`checkout ${branch}: ${co.out}`);
    const sha = lastLine(co.out);
    updatePreview(db(), id, { headSha: sha });
    return { preview: viewPreview(getPreview(db(), id)!), ready: { repoRoot, sha } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Candidates for a provisioning preview (the Discover step). */
export async function discoverForPreview(
  id: string,
  deps: PreviewDeps = {},
): Promise<{ candidates: PreviewCandidate[] } | { error: string }> {
  const p = getPreview(db(), id);
  if (!p || p.deletedAt) return { error: `no preview ${id}` };
  if (p.status !== "provisioning") return { error: `preview ${id} is ${p.status}, not provisioning` };
  const lease = getLease(db(), p.sandboxId);
  const ctx = previewContext(p);
  if (!lease || lease.status !== "running" || !ctx) {
    return { error: `sandbox is ${lease?.status ?? "missing"}` };
  }
  try {
    const handle = (deps.provider ?? sandboxProvider()).attach(lease.ref, "/");
    return { candidates: await discoverPreviewCandidates(handle, ctx.repoRoot) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ConfirmInput {
  workDir?: string;
  install?: string;
  command?: string;
  port?: number;
  label?: string;
  /** Sparse per-preview env overrides; also becomes the setup's env
   *  when saving (the form's env block IS the setup editor). */
  env?: Record<string, string>;
  saveSetup?: boolean;
}

export interface ConfirmResult {
  preview: PreviewView;
  log?: string;
  /** Why nothing launched (missing values, bad setup, failed install). */
  error?: string;
}

/**
 * Confirm a provisioning preview: resolve values (input → saved setup),
 * optionally SAVE the setup, run `install` at the repo root, launch.
 * The row's workDir becomes `<repoRoot>/<workDir>`; from here the
 * lifecycle is the ordinary 0016 one.
 */
export async function confirmBranchPreview(
  id: string,
  input: ConfirmInput,
  deps: PreviewDeps = {},
): Promise<ConfirmResult> {
  const p = getPreview(db(), id);
  if (!p || p.deletedAt) throw new PreviewError("not-found", `no preview ${id}`);
  if (p.status !== "provisioning") {
    throw new PreviewError("invalid", `preview ${id} is ${p.status} — only a provisioning preview can confirm`);
  }
  const ctx = previewContext(p);
  if (!ctx || !p.repoId) throw new PreviewError("sandbox-gone", "no repo context for the preview");
  const setup = getPreviewSetupDefinition(db(), ctx.projectId);

  const workDirRel = (input.workDir ?? setup?.workDir ?? ".").replace(/^\.\/+/, "") || ".";
  const command = input.command ?? setup?.command;
  const install = input.install ?? setup?.install;
  const port = input.port ?? setup?.port;
  const missing = [
    ...(command ? [] : ["command"]),
    ...(install ? [] : ["install"]),
    ...(port ? [] : ["port"]),
  ];
  if (missing.length) {
    return { preview: viewPreview(p), error: `missing ${missing.join(", ")} — pick a candidate or save a setup` };
  }

  if (input.saveSetup) {
    const saved = savePreviewSetup(db(), ctx.projectId, {
      repo: p.repoId,
      workDir: workDirRel,
      install: install!,
      command: command!,
      port: port!,
      env: input.env ?? setup?.env ?? {},
      services: setup?.services ?? [],
      ...(setup?.provision ? { provision: setup.provision } : {}),
    });
    if (!saved.ok) {
      return { preview: viewPreview(p), error: `setup invalid: ${saved.issues.join("; ")}` };
    }
  }

  updatePreview(db(), id, {
    workDir: workDirRel === "." ? ctx.repoRoot : `${ctx.repoRoot}/${workDirRel}`,
    command: command!,
    port: port!,
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
  });

  const lease = getLease(db(), p.sandboxId)!;
  const provider = deps.provider ?? sandboxProvider();
  const handle = provider.attach(lease.ref, ctx.repoRoot);
  const installRun = await sh(handle, `set -o pipefail; ${install} 2>&1 | tail -60`, ctx.repoRoot);
  if (!installRun.ok) {
    const detail = `install failed:\n${installRun.out}`;
    updatePreview(db(), id, { status: "failed", error: detail, failedSha: p.headSha ?? CREATE_FAILED });
    recordPreviewEvent(db(), { previewId: id, sha: p.headSha ?? CREATE_FAILED, result: "failed", detail });
    return { preview: viewPreview(getPreview(db(), id)!), error: "install failed" };
  }

  const launched = await launchPreview(id, deps);
  const sha = p.headSha ?? CREATE_FAILED;
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
  }
  return { preview: viewPreview(getPreview(db(), id)!), ...(launched.log ? { log: launched.log } : {}) };
}

export interface CreateResult {
  preview: PreviewView;
  /** Present when nothing could be resolved — the form's Discover step. */
  candidates?: PreviewCandidate[];
  log?: string;
}

/**
 * The one-shot create: provision, then either confirm straight away
 * (explicit values or the saved setup cover command/install/port) or
 * return the discovered candidates and leave the row `provisioning`
 * for a confirm.
 */
export async function createBranchPreview(
  input: CreateBranchPreviewInput,
  deps: PreviewDeps = {},
): Promise<CreateResult> {
  const provisioned = await provisionBranchPreview(input, deps);
  if (!provisioned.ready) return { preview: provisioned.preview };
  const setup = getPreviewSetupDefinition(db(), input.projectId);
  const resolvable =
    (input.command ?? setup?.command) && (input.install ?? setup?.install) && (input.port ?? setup?.port);
  if (resolvable) {
    const confirmed = await confirmBranchPreview(
      provisioned.preview.id,
      { ...input, saveSetup: input.saveSetup ?? false },
      deps,
    );
    return { preview: confirmed.preview, ...(confirmed.log ? { log: confirmed.log } : {}) };
  }
  const discovered = await discoverForPreview(provisioned.preview.id, deps);
  if ("error" in discovered) {
    updatePreview(db(), provisioned.preview.id, {
      status: "failed",
      error: discovered.error,
      failedSha: CREATE_FAILED,
    });
    return { preview: viewPreview(getPreview(db(), provisioned.preview.id)!) };
  }
  return { preview: provisioned.preview, candidates: discovered.candidates };
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
  // A provisioning preview is driven by its create/confirm request.
  if (p.status === "provisioning") return { ...base, action: "skipped", detail: "provisioning" };
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
    // Reinstall from the setup's explicit `install` (0017); a legacy
    // row without a setup relies on its command installing for itself.
    if (depsChanged) {
      const setup = setupFor(p);
      const ctx = previewContext(p);
      if (setup?.install && ctx) {
        const install = await sh(
          handle,
          `set -o pipefail; ${setup.install} 2>&1 | tail -60`,
          ctx.repoRoot,
        );
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
 * the remote has now. A worktree preview just relaunches; a branch
 * preview that failed before it ever booted re-provisions from scratch.
 */
export async function retryPreview(id: string, deps: PreviewDeps = {}): Promise<FollowReport> {
  const p = getPreview(db(), id);
  if (!p || p.deletedAt) throw new PreviewError("not-found", `no preview ${id}`);
  if (p.source !== "branch") {
    const { preview } = await launchPreview(id, deps);
    return { previewId: id, action: preview.status === "healthy" ? "deployed" : "failed" };
  }
  if (p.failedSha === CREATE_FAILED) {
    // The sandbox was destroyed at failure time — start over.
    const ctx = previewContext(p) ?? { projectId: "", repoRoot: "" };
    const branch = p.branch ?? "main";
    markPreviewDeleted(db(), p.id);
    if (!p.repoId || !ctx.projectId) {
      return { previewId: p.id, action: "failed", detail: "no repo context to re-provision" };
    }
    const provisioned = await provisionBranchPreview(
      { projectId: ctx.projectId, repoId: p.repoId, branch, label: p.label ?? undefined },
      deps,
    );
    if (!provisioned.ready) {
      return { previewId: p.id, action: "failed", detail: provisioned.preview.error ?? "provisioning failed" };
    }
    const setup = getPreviewSetupDefinition(db(), ctx.projectId);
    if (!setup) {
      return { previewId: provisioned.preview.id, action: "skipped", detail: "provisioned — confirm with values" };
    }
    const confirmed = await confirmBranchPreview(provisioned.preview.id, {}, deps);
    return {
      previewId: provisioned.preview.id,
      action: confirmed.preview.status === "healthy" ? "deployed" : "failed",
      ...(confirmed.error ? { detail: confirmed.error } : {}),
    };
  }
  // Forget the failure; headSha null makes the follower treat it as a
  // full deploy (install + restart) of the remote head.
  updatePreview(db(), id, { failedSha: null, headSha: null, status: "failed", error: null });
  return followPreview(getPreview(db(), id)!, deps);
}

/** Dismiss: hide this failing sha's Inbox item (a new failure shows again). */
export function dismissPreviewFailure(id: string): void {
  const p = getPreview(db(), id);
  if (!p) throw new PreviewError("not-found", `no preview ${id}`);
  updatePreview(db(), id, { dismissedSha: p.failedSha });
}
