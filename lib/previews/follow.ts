import { db } from "@/db";
import { getPreviewSetupDefinition } from "@/db/preview-setups";
import { getPreview, listBranchPreviews, markPreviewDeleted, recordPreviewEvent, updatePreview, type Preview } from "@/db/previews";
import { getLease } from "@/db/sandboxes";
import { sandboxProvider } from "@/lib/sandboxes/provider";
import { harnessPreviewNetwork } from "@/lib/previews/network";
import { processAlive, shellQuote } from "@/lib/previews/process";
import { CREATE_FAILED, lastLine, previewContext, setupFor, sh } from "@/lib/previews/context";
import { confirmBranchPreview, provisionBranchPreview } from "@/lib/previews/branch";
import { launchPreview, PreviewError, type PreviewDeps } from "@/lib/previews/service";

/**
 * 0017: the branch-preview follower — one deterministic pass advances a
 * preview to its branch's remote head (fetch → ff / hard reset →
 * reinstall on dependency changes → relaunch or trust HMR), plus the
 * Retry and Dismiss actions on its failures. Creation lives in branch.ts.
 */

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
