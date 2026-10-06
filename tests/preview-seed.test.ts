import type { Experimental_SandboxSession } from "ai";
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { insertPreview, updatePreview } from "../db/previews";
import { getLease } from "../db/sandboxes";
import { savePreviewSetup } from "../db/preview-setups";
import { projectRepos, projects } from "../db/schema";
import { launchPreview } from "../lib/previews/service";
import type { PreviewNetwork } from "../lib/previews/network";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";

/**
 * 0017 amendment: `seed` — the once-per-sandbox data step after
 * `migrate`, before the server. Ordering, independent markers
 * (migrated-before-seed still seeds; a failed seed never
 * regresses migrate), and Retry re-running a failed seed.
 */

db().insert(projects).values({ id: "p_seed", name: "Seed", createdAt: 0 }).onConflictDoNothing().run();
db()
  .insert(projectRepos)
  .values({ id: "p_seed/web", projectId: "p_seed", url: "https://git.example/web.git", name: "web", createdAt: 0 })
  .onConflictDoNothing()
  .run();

class SeedSandbox implements SandboxProvider {
  readonly kind = "podman";
  ran: string[] = [];
  migrateRuns = 0;
  seedRuns = 0;
  failSeed = false;
  attach(ref: string): SandboxHandle {
    return {
      ref,
      run: async (command) => {
        this.ran.push(command);
        if (command.includes("pnpm -w run migrate")) {
          this.migrateRuns += 1;
          return { exitCode: 0, stdout: "migrated", stderr: "" };
        }
        if (command.includes("pnpm run seed")) {
          this.seedRuns += 1;
          return this.failSeed
            ? { exitCode: 1, stdout: "", stderr: "seed boom" }
            : { exitCode: 0, stdout: "seeded", stderr: "" };
        }
        if (command.includes("setsid nohup")) return { exitCode: 0, stdout: "", stderr: "" };
        if (command.includes("echo alive")) return { exitCode: 0, stdout: "alive\n", stderr: "" };
        if (command.startsWith("tail -n")) return { exitCode: 0, stdout: "server up\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: (() => {
        throw new Error("unused");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
  async create(): Promise<SandboxHandle> {
    throw new Error("unused");
  }
  async stop() {}
  async resume() {}
  async destroy() {}
}

const networkFor = (): PreviewNetwork => ({
  connect: async () => {},
  target: (ref, port) => ({ host: ref, port }),
  probe: async () => true,
});

let n = 0;
function seedPreviewFixture(): { previewId: string; sandboxId: string } {
  n += 1;
  const previewId = `pv_seed${n}`;
  const sandboxId = `sbx_seed${n}`;
  db().$client
    .prepare(
      "insert into sandboxes (id, provider, ref, owner_kind, owner_id, status, last_used_at, created_at) " +
        "values (?, 'podman', ?, 'preview', ?, 'running', ?, 0)",
    )
    .run(sandboxId, `ref-${sandboxId}`, previewId, Date.now());
  insertPreview(db(), {
    id: previewId,
    sandboxId,
    workDir: `/work/${previewId}/web`,
    command: "pnpm run dev",
    port: 3000,
    label: "seed-test",
    source: "branch",
    repoId: "p_seed/web",
    branch: "main",
    startedBy: "user",
  });
  updatePreview(db(), previewId, { status: "stopped", headSha: "a".repeat(40) });
  return { previewId, sandboxId };
}

const setupWithSeed = () =>
  savePreviewSetup(db(), "p_seed", {
    repo: "p_seed/web",
    workDir: ".",
    install: "pnpm install",
    migrate: "pnpm -w run migrate",
    seed: "pnpm run seed",
    command: "pnpm run dev",
    port: 3000,
    env: {},
    services: [],
  });

const fast = { healthTimeoutMs: 30, pollMs: 1, serviceProbeMs: 50 };

describe("0017 amendment: seed", () => {
  it("runs migrate → seed → server, once each per sandbox", async () => {
    const { previewId, sandboxId } = seedPreviewFixture();
    setupWithSeed();
    const sbx = new SeedSandbox();
    const result = await launchPreview(previewId, { provider: sbx, network: networkFor(), ...fast });
    expect(result.preview.status).toBe("healthy");
    const migrateAt = sbx.ran.findIndex((c) => c.includes("pnpm -w run migrate"));
    const seedAt = sbx.ran.findIndex((c) => c.includes("pnpm run seed"));
    const startAt = sbx.ran.findIndex((c) => c.includes("setsid nohup"));
    expect(migrateAt).toBeGreaterThan(-1);
    expect(seedAt).toBeGreaterThan(migrateAt);
    expect(startAt).toBeGreaterThan(seedAt);

    // relaunch: neither step re-runs, both markers set
    const again = await launchPreview(previewId, { provider: sbx, network: networkFor(), ...fast });
    expect(again.preview.status).toBe("healthy");
    expect(sbx.migrateRuns).toBe(1);
    expect(sbx.seedRuns).toBe(1);
    const lease = getLease(db(), sandboxId)!;
    expect(lease.migratedAt).toBeGreaterThan(0);
    expect(lease.seededAt).toBeGreaterThan(0);
  });

  it("a sandbox migrated before seed existed still seeds", async () => {
    const { previewId, sandboxId } = seedPreviewFixture();
    setupWithSeed();
    db()
      .$client.prepare("update sandboxes set migrated_at = ? where id = ?")
      .run(Date.now(), sandboxId);
    const sbx = new SeedSandbox();
    const result = await launchPreview(previewId, { provider: sbx, network: networkFor(), ...fast });
    expect(result.preview.status).toBe("healthy");
    expect(sbx.migrateRuns).toBe(0);
    expect(sbx.seedRuns).toBe(1);
  });

  it("a failed seed parks the preview, keeps markers honest, and Retry re-runs", async () => {
    const { previewId, sandboxId } = seedPreviewFixture();
    setupWithSeed();
    const sbx = new SeedSandbox();
    sbx.failSeed = true;
    const result = await launchPreview(previewId, { provider: sbx, network: networkFor(), ...fast });
    expect(result.preview.status).toBe("failed");
    expect(result.preview.error).toContain("seed failed:");
    expect(result.preview.error).toContain("seed boom");
    // the server never started; migrate succeeded and stays marked; seed does not
    expect(sbx.ran.some((c) => c.includes("setsid nohup"))).toBe(false);
    const lease = getLease(db(), sandboxId)!;
    expect(lease.migratedAt).toBeGreaterThan(0);
    expect(lease.seededAt).toBeNull();

    // Retry (a new launch attempt): seed re-runs, succeeds, marks
    sbx.failSeed = false;
    const retried = await launchPreview(previewId, { provider: sbx, network: networkFor(), ...fast });
    expect(retried.preview.status).toBe("healthy");
    expect(sbx.seedRuns).toBe(2);
    expect(getLease(db(), sandboxId)!.seededAt).toBeGreaterThan(0);
  });
});
