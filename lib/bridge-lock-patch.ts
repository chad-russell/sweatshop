import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * vercel/ai#23829 workaround. Upstream tarballs of
 * `@ai-sdk/harness-claude-code` (from 1.0.163) and
 * `@ai-sdk/harness-codex` (from 1.0.161) are published WITHOUT
 * `dist/bridge/pnpm-lock.yaml`, while the adapters still register it
 * unconditionally —
 * `createReadBridgeAsset({..., "pnpm-lock.yaml": new URL("./bridge/pnpm-lock.yaml", import.meta.url)})`
 * — so the first claude/codex harness call fails bridge bootstrap with
 * ENOENT. The fix is merged upstream but unpublished, so we vendor one
 * lockfile per package under `vendor/bridge-locks/<pkg>@<version>/`
 * and copy it into the installed package at boot.
 *
 * Guards, in order:
 * - `BRIDGE_LOCK_PATCH=off` disables the whole pass.
 * - EXACT version match: a vendored lockfile is valid for the
 *   installed bridge bundle only because the bridge `package.json`
 *   deps are identical to the last-good versions (claude 1.0.162,
 *   codex 1.0.160). Any other installed version — including a future
 *   one with the upstream fix — skips with one logged line (installed
 *   ≠ vendored, the actionable self-retire signal), so the patch
 *   retires the moment the dependency bumps; a new regression needs a
 *   new entry, added deliberately.
 * - NEVER overwrite: if the target file already exists (upstream
 *   shipped it, an operator placed one), it wins untouched.
 *
 * Resolution goes through node's own module resolution via
 * `createRequire`, the same posture as ssh2 in lib/hosts/transport.ts:
 * this module is bundled by Turbopack behind instrumentation, and a
 * dynamic `import(expression)` cannot be bundled, while
 * `require.resolve` stays a plain runtime call. The vendored path is
 * cwd-relative like `skills/` (lib/skill-files.ts) — the app process
 * runs from the repo root.
 *
 * Production finding (2026-10-27 deploy): Turbopack compiles
 * `import.meta` into a shim OBJECT that node's createRequire rejects
 * outright (ERR_INVALID_ARG_VALUE), so a top-level
 * `createRequire(import.meta.url)` made this whole pass no-op in the
 * shipped bundle — invisibly, because a blanket catch in the resolver
 * ate the error as "not installed". Two answers, both below: the
 * anchor is built lazily with a cwd fallback (the server always runs
 * with cwd = repo root in every deployment shape — dev, container,
 * tests), and only genuine absence (MODULE_NOT_FOUND /
 * ERR_MODULE_NOT_FOUND from the resolve itself) stays quiet —
 * anything else rethrows to the per-entry catch and logs one line.
 */

/** One vendored bridge lockfile and the exact package it is valid for. */
export interface BridgeLockPatchEntry {
  /** npm package name, resolved through node module resolution. */
  name: string;
  /** The EXACT installed version this lockfile matches — anything else skips. */
  version: string;
  /** Repo-relative vendored lockfile path under `vendor/bridge-locks/`. */
  lockfile: string;
}

/** The known-affected installs and their vendored lockfiles. */
export const BRIDGE_LOCK_PATCHES: readonly BridgeLockPatchEntry[] = [
  {
    name: "@ai-sdk/harness-claude-code",
    version: "1.0.169",
    lockfile: "vendor/bridge-locks/@ai-sdk/harness-claude-code@1.0.169/pnpm-lock.yaml",
  },
  {
    name: "@ai-sdk/harness-codex",
    version: "1.0.167",
    lockfile: "vendor/bridge-locks/@ai-sdk/harness-codex@1.0.167/pnpm-lock.yaml",
  },
];

/** The fs surface the patch needs — a type so tests can inject their own. */
export interface BridgeLockIO {
  fileExists(file: string): Promise<boolean>;
  mkdirp(dir: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
}

/** The node:fs/promises implementation the boot pass uses (and tests reuse). */
export const nodeIO: BridgeLockIO = {
  fileExists: async (file) => {
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  },
  mkdirp: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  copyFile: (from, to) => copyFile(from, to),
};

export type BridgeLockPatchOutcome = "copied" | "skip-version" | "skip-exists";

/**
 * One entry with everything resolved to real paths. The decision is
 * pure — exact version equality, then target existence — and only the
 * copy itself touches the filesystem, through `io`.
 */
export async function patchBridgeLockEntry(
  entry: Pick<BridgeLockPatchEntry, "name" | "version">,
  installed: { version: string; dir: string },
  vendoredFile: string,
  io: BridgeLockIO,
): Promise<BridgeLockPatchOutcome> {
  if (installed.version !== entry.version) return "skip-version";
  const target = path.join(installed.dir, "dist", "bridge", "pnpm-lock.yaml");
  if (await io.fileExists(target)) return "skip-exists";
  await io.mkdirp(path.dirname(target));
  await io.copyFile(vendoredFile, target);
  return "copied";
}

/** Everything the driver needs beyond the registry; injected for tests. */
export interface BridgeLockPatchDeps {
  /** The installed package, or null when it is not installed at all. */
  resolveInstalled(name: string): Promise<{ version: string; dir: string } | null>;
  /** Absolute path of the vendored lockfile for an entry. */
  vendoredFile(entry: BridgeLockPatchEntry): string;
  io: BridgeLockIO;
  env: Readonly<Record<string, string | undefined>>;
  log?(line: string): void;
}

/**
 * The env-gated pass over the registry: kill-switch first, then one
 * entry at a time, never throwing — a failed entry logs one line and
 * the pass moves on, so boot (the only caller) stays safe regardless.
 */
export async function runBridgeLockPatch(
  entries: readonly BridgeLockPatchEntry[],
  deps: BridgeLockPatchDeps,
): Promise<BridgeLockPatchOutcome[]> {
  if (deps.env.BRIDGE_LOCK_PATCH === "off") return [];
  const outcomes: BridgeLockPatchOutcome[] = [];
  for (const entry of entries) {
    try {
      const installed = await deps.resolveInstalled(entry.name);
      if (!installed) continue;
      const outcome = await patchBridgeLockEntry(entry, installed, deps.vendoredFile(entry), deps.io);
      outcomes.push(outcome);
      if (outcome === "copied") {
        deps.log?.(`[bridge-lock-patch] vendored ${entry.name}@${entry.version} pnpm-lock.yaml (vercel/ai#23829)`);
      } else if (outcome === "skip-version") {
        deps.log?.(
          `[bridge-lock-patch] ${entry.name} ${installed.version} ≠ vendored ${entry.version} — registry stale, upstream fixed?`,
        );
      }
    } catch (err) {
      deps.log?.(`[bridge-lock-patch] ${entry.name} skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return outcomes;
}

/** The minimal shape of node's require the resolver needs. */
export interface RequireLike {
  resolve(specifier: string): string;
}

let anchoredRequire: RequireLike | null = null;

/**
 * A createRequire anchor, built lazily ONCE (module state, never at
 * top level, so a throwing anchor cannot reject the whole module
 * import — instrumentation's `await import` must stay safe). The
 * natural anchor is this module's own URL; in a Turbopack production
 * bundle import.meta is a shim OBJECT node rejects
 * (ERR_INVALID_ARG_VALUE, the 2026-10-27 deploy failure), and the
 * server always runs with cwd = repo root, so fall back to anchoring
 * there — resolution walks up to the same node_modules either way.
 */
function anchorRequire(): RequireLike {
  if (anchoredRequire) return anchoredRequire;
  try {
    anchoredRequire = createRequire(import.meta.url);
  } catch {
    anchoredRequire = createRequire(path.join(process.cwd(), "package.json"));
  }
  return anchoredRequire;
}

/**
 * Resolve one installed package through a require-like — the real
 * resolver feeds anchorRequire(); tests feed a fake (the one seam).
 * Only GENUINE absence (MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND from
 * the resolve itself) maps to null and stays quiet; any other error
 * rethrows so runBridgeLockPatch's per-entry catch logs it — the
 * 2026-10-27 deploy no-op'd invisibly because a blanket catch here
 * ate ERR_INVALID_ARG_VALUE as "not installed". A resolved but
 * unreadable/malformed package.json still maps to null (absent enough
 * — nothing to patch, not worth a boot line).
 */
export async function resolveInstalledWith(
  req: RequireLike,
  name: string,
): Promise<{ version: string; dir: string } | null> {
  let file: string;
  try {
    file = req.resolve(`${name}/package.json`);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") return null;
    throw err;
  }
  try {
    const pkg = JSON.parse(await readFile(file, "utf8")) as { version?: unknown };
    if (typeof pkg.version !== "string") return null;
    return { version: pkg.version, dir: path.dirname(file) };
  } catch {
    return null;
  }
}

async function resolveInstalled(name: string): Promise<{ version: string; dir: string } | null> {
  return resolveInstalledWith(anchorRequire(), name);
}

/**
 * The boot-time pass `instrumentation-node.ts` awaits — never throws;
 * entries are skipped (one log line) rather than failing the boot.
 */
export async function applyBridgeLockPatch(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  await runBridgeLockPatch(BRIDGE_LOCK_PATCHES, {
    resolveInstalled,
    vendoredFile: (entry) => path.join(process.cwd(), entry.lockfile),
    io: nodeIO,
    env,
    log: (line) => console.log(line),
  });
}
