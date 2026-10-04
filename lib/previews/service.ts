import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  findPreview,
  getPreview,
  insertPreview,
  listWatchedPreviews,
  markPreviewDeleted,
  previewSandbox,
  updatePreview,
  type NewPreview,
  type Preview,
  type PreviewStatus,
} from "@/db/previews";
import { getPreviewSetupDefinition } from "@/db/preview-setups";
import { conversations, machineRuns, projectRepos } from "@/db/schema";
import { getLease, touchLease, updateLease } from "@/db/sandboxes";
import { envFileContent, maskEnv, resolvePreviewEnv } from "@/lib/previews/env";
import { previewHost, previewUrl, harnessPreviewNetwork, type PreviewNetwork } from "@/lib/previews/network";
import { logTail, processAlive, shellQuote, startProcess, stopProcess } from "@/lib/previews/process";
import { sandboxProvider, type SandboxHandle, type SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * 0016: the preview lifecycle — the one start / stop / reconcile path
 * the agent tools, the routes, the tick, and the follower share. It
 * reaches the sandbox only through the provider seam (SandboxHandle.run)
 * and the network seam, so tests run it against fakes.
 */

export interface PreviewDeps {
  provider?: SandboxProvider;
  network?: PreviewNetwork;
  /** Health wait budget for start (ms). */
  healthTimeoutMs?: number;
  /** Poll interval while waiting (ms). */
  pollMs?: number;
}

function deps(d: PreviewDeps = {}) {
  return {
    provider: d.provider ?? sandboxProvider(),
    network: d.network ?? harnessPreviewNetwork,
    healthTimeoutMs: d.healthTimeoutMs ?? 90_000,
    pollMs: d.pollMs ?? 1_000,
  };
}

export class PreviewError extends Error {
  constructor(
    readonly code: "not-found" | "sandbox-gone" | "invalid" | "launch-failed",
    message: string,
  ) {
    super(message);
  }
}

/** A preview as the UI and tools see it. */
export interface PreviewView {
  id: string;
  slug: string;
  url: string;
  host: string;
  label: string | null;
  status: PreviewStatus;
  source: Preview["source"];
  sandboxId: string;
  workDir: string;
  command: string;
  port: number;
  branch: string | null;
  headSha: string | null;
  startedBy: string;
  error: string | null;
  lastRequestAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export function viewPreview(p: Preview): PreviewView {
  return {
    id: p.id,
    slug: p.slug,
    url: previewUrl(p.slug),
    host: previewHost(p.slug),
    label: p.label,
    status: p.status,
    source: p.source,
    sandboxId: p.sandboxId,
    workDir: p.workDir,
    command: p.command,
    port: p.port,
    branch: p.branch,
    headSha: p.headSha,
    startedBy: p.startedBy,
    error: p.error,
    lastRequestAt: p.lastRequestAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/**
 * A live handle on the preview's sandbox: resumes a stopped one (a
 * preview start is real use), refuses a destroyed one. Joins it to the
 * preview network so the proxy and probe can dial it.
 */
async function openPreviewSandbox(
  sandboxId: string,
  provider: SandboxProvider,
  network: PreviewNetwork,
): Promise<{ handle: SandboxHandle; ref: string }> {
  const lease = getLease(db(), sandboxId);
  if (!lease || lease.status === "destroyed" || lease.status === "creating") {
    throw new PreviewError("sandbox-gone", `sandbox ${sandboxId} is ${lease?.status ?? "missing"}`);
  }
  if (lease.status === "stopped") {
    await provider.resume(lease.ref);
    updateLease(db(), lease.id, { status: "running" });
  }
  touchLease(db(), lease.id);
  await network.connect(lease.ref);
  return { handle: provider.attach(lease.ref, "/"), ref: lease.ref };
}

/** Env every preview process gets: where it is served from. */
export function previewEnv(p: Pick<Preview, "slug" | "port">): Record<string, string> {
  return {
    PORT: String(p.port),
    HOST: "0.0.0.0",
    PREVIEW_HOST: previewHost(p.slug),
    PREVIEW_URL: previewUrl(p.slug),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the preview answers HTTP, its process dies, or the budget
 * runs out. Returns the resulting status and, when not healthy, why.
 */
async function awaitHealthy(
  p: Preview,
  handle: SandboxHandle,
  ref: string,
  network: PreviewNetwork,
  timeoutMs: number,
  pollMs: number,
): Promise<{ status: PreviewStatus; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await network.probe(ref, p.port)) return { status: "healthy", error: null };
    if (!(await processAlive(handle, p.id))) {
      return { status: "crashed", error: `exited before serving on port ${p.port}` };
    }
    if (Date.now() >= deadline) {
      return { status: "starting", error: `not answering on port ${p.port} after ${Math.round(timeoutMs / 1000)}s` };
    }
    await sleep(pollMs);
  }
}

export interface StartResult {
  preview: PreviewView;
  /** The log tail when the preview is not healthy (the model reads it). */
  log?: string;
}

/** The project a preview belongs to (whose setup's env applies):
 *  branch previews through their repo, worktree previews through their
 *  sandbox owner (conversation or machine run). */
export function previewProjectId(p: Preview): string | null {
  if (p.repoId) {
    const repo = db().select({ projectId: projectRepos.projectId }).from(projectRepos).where(eq(projectRepos.id, p.repoId)).get();
    if (repo) return repo.projectId;
  }
  const lease = getLease(db(), p.sandboxId);
  if (!lease) return null;
  if (lease.ownerKind === "conversation") {
    return (
      db()
        .select({ projectId: conversations.projectId })
        .from(conversations)
        .where(eq(conversations.id, lease.ownerId))
        .get()?.projectId ?? null
    );
  }
  if (lease.ownerKind === "machine_run") {
    return (
      db()
        .select({ projectId: machineRuns.projectId })
        .from(machineRuns)
        .where(eq(machineRuns.id, lease.ownerId))
        .get()?.projectId ?? null
    );
  }
  return null;
}

/**
 * 0017: the env a preview boots with — the project setup's env, the
 *  row's sparse overrides, then the platform vars ALWAYS last. Bad
 *  references are a value-shaped error (the caller parks the preview
 *  failed with the reason instead of launching a misconfigured server).
 */
export function resolvedEnvFor(p: Preview): { env: Record<string, string> } | { error: string } {
  const platform = previewEnv(p);
  const base = getPreviewSetupDefinition(db(), previewProjectId(p))?.env ?? {};
  const resolved = resolvePreviewEnv(base, p.env, platform);
  if ("error" in resolved) return resolved;
  // Platform values are final — a preview can never misroute itself.
  return { env: { ...resolved.env, ...platform } };
}

/** Masked env (keys visible) for cards/sheets — the editor sees plain. */
export function previewEnvView(id: string): { env: Record<string, string> } | { error: string } {
  const p = getPreview(db(), id);
  if (!p) return { error: `no preview ${id}` };
  const resolved = resolvedEnvFor(p);
  if ("error" in resolved) return resolved;
  return { env: maskEnv(resolved.env) };
}

/** Launch (or relaunch) a preview row's process and wait for health. */
export async function launchPreview(id: string, d: PreviewDeps = {}): Promise<StartResult> {
  const { provider, network, healthTimeoutMs, pollMs } = deps(d);
  const p = getPreview(db(), id);
  if (!p || p.deletedAt) throw new PreviewError("not-found", `no preview ${id}`);
  const resolved = resolvedEnvFor(p);
  if ("error" in resolved) {
    updatePreview(db(), p.id, { status: "failed", error: resolved.error });
    return { preview: viewPreview(getPreview(db(), p.id)!) };
  }
  const { handle, ref } = await openPreviewSandbox(p.sandboxId, provider, network);
  updatePreview(db(), p.id, { status: "starting", error: null });
  try {
    await startProcess(handle, {
      id: p.id,
      workDir: p.workDir,
      command: p.command,
      env: resolved.env,
      envFileContent: envFileContent(resolved.env),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updatePreview(db(), p.id, { status: "crashed", error: message });
    throw new PreviewError("launch-failed", message);
  }
  const outcome = await awaitHealthy(p, handle, ref, network, healthTimeoutMs, pollMs);
  updatePreview(db(), p.id, { status: outcome.status, error: outcome.error });
  const fresh = getPreview(db(), p.id)!;
  if (outcome.status === "healthy") return { preview: viewPreview(fresh) };
  return { preview: viewPreview(fresh), log: await logTail(handle, p.id) };
}

/**
 * start_preview's core: find-or-create the row for (sandbox, dir, port)
 * — idempotent, so calling again restarts that preview — then launch.
 */
export async function startPreview(input: NewPreview, d: PreviewDeps = {}): Promise<StartResult> {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new PreviewError("invalid", `port must be 1–65535, got ${input.port}`);
  }
  if (!input.workDir.startsWith("/")) {
    throw new PreviewError("invalid", `workDir must be absolute, got ${input.workDir}`);
  }
  const existing = findPreview(db(), input.sandboxId, input.workDir, input.port);
  let id: string;
  if (existing) {
    updatePreview(db(), existing.id, {
      command: input.command,
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
    });
    id = existing.id;
  } else {
    id = insertPreview(db(), input).id;
  }
  return launchPreview(id, d);
}

/** Stop a preview's process; the row stays (Start brings it back). */
export async function stopPreview(id: string, d: PreviewDeps = {}): Promise<PreviewView> {
  const { provider } = deps(d);
  const p = getPreview(db(), id);
  if (!p || p.deletedAt) throw new PreviewError("not-found", `no preview ${id}`);
  const sbx = previewSandbox(db(), p.sandboxId);
  // A stopped/destroyed sandbox has no processes left to kill.
  if (sbx?.status === "running") await stopProcess(provider.attach(sbx.ref, "/"), p.id);
  updatePreview(db(), p.id, { status: "stopped" });
  return viewPreview(getPreview(db(), p.id)!);
}

/** Stop and hide a preview. The caller decides what happens to its sandbox. */
export async function deletePreview(id: string, d: PreviewDeps = {}): Promise<void> {
  const p = getPreview(db(), id);
  if (!p || p.deletedAt) return;
  await stopPreview(id, d).catch(() => undefined);
  markPreviewDeleted(db(), id);
}

/** Status + log tail (preview_status, the Logs sheet). */
export async function previewLogs(id: string, lines = 80, d: PreviewDeps = {}): Promise<string> {
  const { provider } = deps(d);
  const p = getPreview(db(), id);
  if (!p) throw new PreviewError("not-found", `no preview ${id}`);
  const sbx = previewSandbox(db(), p.sandboxId);
  if (sbx?.status !== "running") return "";
  return logTail(provider.attach(sbx.ref, "/"), p.id, lines);
}

/**
 * One reconcile pass: for every watched preview, read reality (sandbox
 * state, process liveness, HTTP answer) and correct the row. Never
 * restarts anything — a crash is reported, not hidden. `failed` rows
 * belong to the follower and are left alone. Errors are per preview.
 */
export async function reconcilePreviews(d: PreviewDeps = {}): Promise<{ changed: string[]; errors: string[] }> {
  const { provider, network } = deps(d);
  const changed: string[] = [];
  const errors: string[] = [];
  for (const p of listWatchedPreviews(db())) {
    if (p.status === "failed") continue;
    try {
      const next = await observe(p, provider, network);
      if (next.status !== p.status) {
        updatePreview(db(), p.id, next);
        changed.push(`${p.id}:${p.status}->${next.status}`);
      }
    } catch (err) {
      errors.push(`${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { changed, errors };
}

async function observe(
  p: Preview,
  provider: SandboxProvider,
  network: PreviewNetwork,
): Promise<{ status: PreviewStatus; error?: string | null }> {
  const sbx = previewSandbox(db(), p.sandboxId);
  if (!sbx || sbx.status !== "running") return { status: "stopped" };
  const handle = provider.attach(sbx.ref, "/");
  if (!(await processAlive(handle, p.id))) {
    return p.status === "crashed" ? { status: "crashed" } : { status: "crashed", error: "process exited" };
  }
  if (await network.probe(sbx.ref, p.port)) return { status: "healthy", error: null };
  // Alive but not answering: still booting, or wedged after being up.
  return p.status === "healthy" ? { status: "crashed", error: `stopped answering on port ${p.port}` } : { status: p.status };
}

// ── command inference ───────────────────────────────────────────────────
// 0017: inference is gone — discovery (lib/previews/discover.ts) fills
// the New-preview form once, the result is saved as the project's setup
// (db/preview-setups.ts), and launches read the setup. Nothing guesses
// per launch any more.

/** Quote helper re-exported for callers composing commands. */
export { shellQuote };
