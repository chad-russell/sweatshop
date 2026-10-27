import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BRIDGE_LOCK_PATCHES,
  nodeIO,
  patchBridgeLockEntry,
  runBridgeLockPatch,
  type BridgeLockPatchEntry,
} from "../lib/bridge-lock-patch";

/**
 * vercel/ai#23829 workaround: the boot-time bridge lockfile patch —
 * exact-version guard, never-overwrite, and the BRIDGE_LOCK_PATCH=off
 * kill-switch. Everything runs against a real temp dir through the
 * SAME node:fs/promises io the boot pass uses; the createRequire
 * resolution layer stays thin and is deliberately not exercised here.
 */

const root = mkdtempSync(path.join(os.tmpdir(), "bridge-lock-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fake installed package dir + a distinct vendored lockfile beside it
 *  (unique per call — several tests patch the same name@version). */
let fixtureSeq = 0;
async function fixture(entry: Pick<BridgeLockPatchEntry, "name" | "version">, installedVersion: string) {
  const pkgDir = path.join(
    root,
    `${entry.name.replace(/^@/, "").replaceAll("/", "-")}-${installedVersion}-${fixtureSeq++}`,
  );
  const vendoredFile = path.join(root, `${path.basename(pkgDir)}-vendored.yaml`);
  await writeFile(vendoredFile, `# vendored lockfile for ${entry.name}@${entry.version}\n`);
  return { pkgDir, vendoredFile };
}

const bridgeLock = (pkgDir: string) => path.join(pkgDir, "dist", "bridge", "pnpm-lock.yaml");

const CLAUDE = BRIDGE_LOCK_PATCHES[0];

describe("bridge lockfile patch (vercel/ai#23829)", () => {
  it("copies the vendored lockfile when the version matches exactly and the bridge file is missing", async () => {
    const { pkgDir, vendoredFile } = await fixture(CLAUDE, "1.0.169");
    expect(await nodeIO.fileExists(bridgeLock(pkgDir))).toBe(false);
    const outcome = await patchBridgeLockEntry(CLAUDE, { version: "1.0.169", dir: pkgDir }, vendoredFile, nodeIO);
    expect(outcome).toBe("copied");
    expect(await nodeIO.fileExists(bridgeLock(pkgDir))).toBe(true);
    await expect(readFile(bridgeLock(pkgDir), "utf8")).resolves.toContain(
      `# vendored lockfile for ${CLAUDE.name}@${CLAUDE.version}`,
    );
  });

  it("skips (and writes nothing) when the installed version does not match exactly", async () => {
    const { pkgDir, vendoredFile } = await fixture(CLAUDE, "9.9.9");
    const outcome = await patchBridgeLockEntry(CLAUDE, { version: "9.9.9", dir: pkgDir }, vendoredFile, nodeIO);
    expect(outcome).toBe("skip-version");
    expect(await nodeIO.fileExists(path.join(pkgDir, "dist"))).toBe(false);
  });

  it("never overwrites a lockfile that is already present", async () => {
    const { pkgDir, vendoredFile } = await fixture(CLAUDE, "1.0.169");
    await mkdir(path.dirname(bridgeLock(pkgDir)), { recursive: true });
    await writeFile(bridgeLock(pkgDir), "# already shipped by upstream\n");
    const outcome = await patchBridgeLockEntry(CLAUDE, { version: "1.0.169", dir: pkgDir }, vendoredFile, nodeIO);
    expect(outcome).toBe("skip-exists");
    await expect(readFile(bridgeLock(pkgDir), "utf8")).resolves.toBe("# already shipped by upstream\n");
  });

  it("is a no-op when BRIDGE_LOCK_PATCH=off (never even resolves the installed package)", async () => {
    const outcomes = await runBridgeLockPatch(BRIDGE_LOCK_PATCHES, {
      resolveInstalled: () => {
        throw new Error("kill-switch must short-circuit before resolution");
      },
      vendoredFile: () => {
        throw new Error("kill-switch must short-circuit before locating vendored files");
      },
      io: nodeIO,
      env: { BRIDGE_LOCK_PATCH: "off" },
    });
    expect(outcomes).toEqual([]);
  });

  it("the driver copies through the registry and skips unresolvable packages without throwing", async () => {
    const { pkgDir, vendoredFile } = await fixture(CLAUDE, "1.0.169");
    const logged: string[] = [];
    const outcomes = await runBridgeLockPatch([CLAUDE], {
      resolveInstalled: async (name) => (name === CLAUDE.name ? { version: CLAUDE.version, dir: pkgDir } : null),
      vendoredFile: () => vendoredFile,
      io: nodeIO,
      env: {},
      log: (line) => logged.push(line),
    });
    expect(outcomes).toEqual(["copied"]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(CLAUDE.name);

    const empty = await runBridgeLockPatch([CLAUDE], {
      resolveInstalled: async () => null,
      vendoredFile: () => {
        throw new Error("unresolved packages never reach the vendored file");
      },
      io: nodeIO,
      env: {},
    });
    expect(empty).toEqual([]);
  });

  it("registry entries point at vendored files that actually exist in the repo", async () => {
    for (const entry of BRIDGE_LOCK_PATCHES) {
      expect(entry.lockfile).toBe(`vendor/bridge-locks/${entry.name}@${entry.version}/pnpm-lock.yaml`);
      expect(await nodeIO.fileExists(path.join(process.cwd(), entry.lockfile))).toBe(true);
    }
  });
});
