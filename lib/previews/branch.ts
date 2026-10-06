import { eq } from "drizzle-orm";
import { db } from "@/db";
import { getPreviewSetupDefinition, savePreviewSetup } from "@/db/preview-setups";
import { getPreview, insertPreview, newPreviewId, recordPreviewEvent, updatePreview } from "@/db/previews";
import { getLease, markDestroyed } from "@/db/sandboxes";
import { projectRepos } from "@/db/schema";
import { activateDedicatedLease, destroySandbox, mintDedicatedLease } from "@/lib/sandboxes/lease";
import { ensureSandboxServices } from "@/lib/sandboxes/services";
import { sandboxWorkRoot } from "@/lib/sandboxes/provision";
import { sandboxProvider } from "@/lib/sandboxes/provider";
import { shellQuote } from "@/lib/previews/process";
import { discoverPreviewCandidates, type PreviewCandidate } from "@/lib/previews/discover";
import type { PreviewOverrides } from "@/lib/previews/overrides";
import { CREATE_FAILED, lastLine, resolvePreviewContext, sh } from "@/lib/previews/context";
import {
  launchPreview,
  deletePreview,
  PreviewError,
  resolvedEnvFor,
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

/** Where to preview (project, repo, branch) plus this preview's values
 *  (lib/previews/overrides.ts — unset fields fall back to the setup). */
export interface CreateBranchPreviewInput extends PreviewOverrides {
  projectId: string;
  repoId: string;
  branch: string;
}

// ── provision / discover / confirm ──────────────────────────────────────

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
    // 0017: declared services start while you pick candidates (ensure
    // is idempotent; launch re-ensures and probes readiness).
    if (setup?.services.length) {
      try {
        await ensureSandboxServices(sandboxId, setup.services, deps.services);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
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
  const ctx = resolvePreviewContext(p);
  if (!lease || lease.status !== "running" || !p.repoId || !ctx.repoRoot) {
    return { error: `sandbox is ${lease?.status ?? "missing"}` };
  }
  try {
    const handle = (deps.provider ?? sandboxProvider()).attach(lease.ref, "/");
    return { candidates: await discoverPreviewCandidates(handle, ctx.repoRoot) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Confirm takes the same values as create. A first setup is saved
 *  from them; unset input keeps the saved setup's values. */
export type ConfirmInput = PreviewOverrides;

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
  const { projectId, repoRoot, setup } = resolvePreviewContext(p);
  if (!p.repoId || !projectId || !repoRoot) {
    throw new PreviewError("sandbox-gone", "no repo context for the preview");
  }

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

  // 0017 amendment: the confirm form is the setup editor — structural
  // fields (and the env block) ALWAYS save; per-preview fields
  // (command, port, label) stay this row's. Unset structural input
  // keeps the saved setup's values, so API confirms behave. ONE
  // exception: a setup bound to a different repo (one setup per
  // project, v1) is never rewritten by previewing that other repo —
  // the edits apply to this row only.
  if (!setup || setup.repo === p.repoId) {
    const saved = savePreviewSetup(db(), projectId, {
      repo: p.repoId,
      workDir: workDirRel,
      install: install!,
      command: command!,
      port: port!,
      env: input.env ?? setup?.env ?? {},
      services: input.services ?? setup?.services ?? [],
      ...((input.provision ?? setup?.provision) ? { provision: input.provision ?? setup!.provision! } : {}),
      ...((input.seed ?? setup?.seed) ? { seed: input.seed ?? setup!.seed! } : {}),
    });
    if (!saved.ok) {
      return { preview: viewPreview(p), error: `setup invalid: ${saved.issues.join("; ")}` };
    }
  }

  updatePreview(db(), id, {
    workDir: workDirRel === "." ? repoRoot : `${repoRoot}/${workDirRel}`,
    command: command!,
    port: port!,
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
  });

  const lease = getLease(db(), p.sandboxId)!;
  const provider = deps.provider ?? sandboxProvider();
  const handle = provider.attach(lease.ref, repoRoot);
  // Install runs with the resolved env (private registries, tokens).
  const bootEnv = resolvedEnvFor(p);
  const installEnv = "env" in bootEnv ? { GIT_TERMINAL_PROMPT: "0", ...bootEnv.env } : { GIT_TERMINAL_PROMPT: "0" };
  const installRun = await sh(handle, `set -o pipefail; ${install} 2>&1 | tail -60`, repoRoot, installEnv);
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
    const confirmed = await confirmBranchPreview(provisioned.preview.id, input, deps);
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
