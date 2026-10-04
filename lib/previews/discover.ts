import type { SandboxHandle } from "@/lib/sandboxes/provider";
import { shellQuote } from "@/lib/previews/process";

/**
 * 0017: discovery — the assisted, once-per-project form fill that
 * replaces 0016's per-launch inference. `discoverPreviewCandidates`
 * scans a checkout for packages with dev/start scripts and returns
 * prefilled candidates; the user (or agent) picks and edits, the result
 * is SAVED as the project's preview setup, and launches never infer
 * again. It fills forms; it never launches anything.
 */

export interface PreviewCandidate {
  /** Directory relative to the repo root ("." for the root itself). */
  dir: string;
  /** Package manager the repo's lockfile says. */
  pm: "npm" | "pnpm" | "yarn" | "bun";
  /** The script used: dev, else start. */
  script: string;
  /** Prefilled server command (framework flags for vite/astro/next). */
  command: string;
  /** Prefilled install command, run at the repo root. */
  install: string;
  port: number;
  /** Prefilled seed command (0017 amendment) when this package has a
   *  `seed` or `db:seed` script — repo-root convention, so it carries
   *  its own `cd`. A form fill, not a guarantee. */
  seed?: string;
}

interface Pkg {
  dir: string;
  scripts: Record<string, string>;
}

const DEFAULT_PORT = 3000;

/**
 * The command prefill for one package's script — the only place the
 * framework shape-guessing lives (vite/astro/next need host/port
 * flags; everything else is trusted to honor $PORT/$HOST).
 */
export function buildCommand(pm: PreviewCandidate["pm"], script: string, body: string): {
  command: string;
  port: number;
} {
  const flags =
    /\bvite\b|\bastro\b/.test(body)
      ? ` --host 0.0.0.0 --port ${DEFAULT_PORT}`
      : /\bnext\b/.test(body)
        ? ` -H 0.0.0.0 -p ${DEFAULT_PORT}`
        : "";
  // Only npm needs `--` to forward flags (pnpm/yarn/bun pass them
  // through, and pnpm would forward a literal `--` that ends options).
  const sep = flags && pm === "npm" ? " --" : "";
  const run = pm === "npm" ? `npm run ${script}` : `${pm} run ${script}`;
  return { command: `${run}${sep}${flags}`, port: DEFAULT_PORT };
}

function candidate(pm: PreviewCandidate["pm"], pkg: Pkg): PreviewCandidate {
  const script = pkg.scripts.dev ? "dev" : "start";
  const { command, port } = buildCommand(pm, script, pkg.scripts[script] ?? "");
  const run = (name: string) => (pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`);
  const seedScript = pkg.scripts.seed ? "seed" : pkg.scripts["db:seed"] ? "db:seed" : undefined;
  return {
    dir: pkg.dir,
    pm,
    script,
    command,
    install: `${pm} install`,
    port,
    ...(seedScript
      ? { seed: pkg.dir === "." ? run(seedScript) : `cd ${pkg.dir} && ${run(seedScript)}` }
      : {}),
  };
}

function parseScripts(text: string | undefined): Record<string, string> | null {
  if (!text?.trim()) return null;
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return null;
  }
}

function pmFromLocks(locks: string): PreviewCandidate["pm"] {
  if (locks.includes("pnpm-lock")) return "pnpm";
  if (locks.includes("yarn.lock")) return "yarn";
  if (locks.includes("bun.lock")) return "bun";
  return "npm";
}

/**
 * Scan a checkout in ONE shell round trip: the root package.json, the
 * root lockfile, and every package.json one level under apps/,
 * packages/, and services/. Candidates: root first, then subpackages,
 * each only when it has a dev or start script.
 */
export async function discoverPreviewCandidates(
  handle: SandboxHandle,
  root: string,
): Promise<PreviewCandidate[]> {
  const script = [
    `cd ${shellQuote(root)} || exit 3`,
    "echo __ROOT__",
    "cat package.json 2>/dev/null || true",
    "echo __LOCKS__",
    "ls -1 pnpm-lock.yaml yarn.lock bun.lockb bun.lock package-lock.json 2>/dev/null || true",
    "echo __PKGS__",
    'for d in apps/* packages/* services/*; do',
    '  [ -f "$d/package.json" ] && { echo "__PKG__${d}"; cat "$d/package.json"; }',
    "done 2>/dev/null || true",
    "echo __END__",
  ].join("\n");
  const result = await handle.run(script, undefined, "/");
  if (result.exitCode !== 0) {
    throw new Error(`could not scan ${root}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  const out = result.stdout;
  const rootJson = out.split("__ROOT__\n")[1]?.split("\n__LOCKS__\n")[0];
  const locks = out.split("__LOCKS__\n")[1]?.split("\n__PKGS__\n")[0] ?? "";
  const pm = pmFromLocks(locks);

  const candidates: PreviewCandidate[] = [];
  const rootScripts = parseScripts(rootJson);
  if (rootScripts?.dev || rootScripts?.start) {
    candidates.push(candidate(pm, { dir: ".", scripts: rootScripts }));
  }
  const pkgBlock = out.split("__PKGS__\n")[1]?.split("\n__END__")[0] ?? "";
  for (const part of pkgBlock.split(/(?=__PKG__)/)) {
    const match = /^__PKG__(.+)\n?/.exec(part);
    if (!match) continue;
    const dir = match[1]!.trim();
    const scripts = parseScripts(part.slice(match[0].length));
    if (scripts?.dev || scripts?.start) {
      candidates.push(candidate(pm, { dir, scripts }));
    }
  }
  return candidates;
}

/**
 * One directory's prefill (the agent tool's fallback when a project has
 * no saved setup yet): dev/start from this dir's package.json, the
 * package manager from the nearest lockfile (this dir or its parent —
 * monorepo packages keep theirs at the root).
 */
export async function describeDir(
  handle: SandboxHandle,
  dir: string,
): Promise<{ command: string; port: number; install: string } | { error: string }> {
  const read = await handle.run(
    `cd ${shellQuote(dir)} 2>/dev/null || exit 3; ` +
      "cat package.json 2>/dev/null; echo __; " +
      "ls -1 pnpm-lock.yaml yarn.lock bun.lockb bun.lock package-lock.json " +
      "../pnpm-lock.yaml ../yarn.lock ../bun.lockb ../bun.lock ../package-lock.json 2>/dev/null || true",
    undefined,
    "/",
  );
  const [pkgText = "", locks = ""] = read.stdout.split("\n__\n");
  const scripts = parseScripts(pkgText);
  if (!scripts) {
    return { error: `no readable package.json in ${dir} — pass command and port explicitly` };
  }
  if (!scripts.dev && !scripts.start) {
    return { error: `package.json in ${dir} has no dev or start script — pass command explicitly` };
  }
  const pm = pmFromLocks(locks);
  const built = buildCommand(pm, scripts.dev ? "dev" : "start", scripts.dev ?? scripts.start ?? "");
  return { command: built.command, port: built.port, install: `${pm} install` };
}
