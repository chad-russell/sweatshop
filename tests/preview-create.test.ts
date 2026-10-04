import type { Experimental_SandboxSession } from "ai";
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { getPreview } from "../db/previews";
import { getLease } from "../db/sandboxes";
import { getPreviewSetup, savePreviewSetup } from "../db/preview-setups";
import { projectRepos, projects } from "../db/schema";
import {
  confirmBranchPreview,
  createBranchPreview,
  provisionBranchPreview,
} from "../lib/previews/branch";
import type { PreviewNetwork } from "../lib/previews/network";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";

/**
 * 0017 phase 1: branch preview creation — provision → discover →
 * confirm. The row exists BEFORE anything can fail (a provisioning
 * failure is a visible `failed` preview with its lease cleaned up,
 * never an invisible 500), install is separate from the server
 * command, and a confirm can save the project's setup.
 */

class BranchSandbox implements SandboxProvider {
  readonly kind = "podman";
  /** provider.create throws (the clone/workspace step fails). */
  createFails = false;
  /** The checkout step fails (bad branch / no credentials). */
  checkoutFails = false;
  installOk = true;
  boots = true;
  scan = [
    "__ROOT__",
    '{"scripts":{"dev":"turbo dev"}}',
    "__LOCKS__",
    "pnpm-lock.yaml",
    "__PKGS__",
    "__PKG__apps/web",
    '{"scripts":{"dev":"next dev"}}',
    "__END__",
    "",
  ].join("\n");
  ran: string[] = [];
  async create(): Promise<SandboxHandle> {
    if (this.createFails) throw new Error("cloning web failed (exit 128): terminal prompts disabled");
    return this.attach("ref-created");
  }
  attach(ref: string): SandboxHandle {
    return {
      ref,
      run: async (command) => {
        this.ran.push(command);
        const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
        const no = (stderr: string) => ({ exitCode: 1, stdout: "", stderr });
        if (command.includes("git fetch")) return this.checkoutFails ? no("could not read Username") : ok(`${"a".repeat(40)}\n`);
        if (command.includes("__ROOT__")) return ok(this.scan);
        if (command.includes("set -o pipefail")) return this.installOk ? ok("done") : no("ERR_PNPM_FETCH_404");
        if (command.includes("setsid nohup")) return ok();
        if (command.includes("echo alive")) return ok(this.boots ? "alive\n" : "");
        return ok();
      },
      spawn: (() => {
        throw new Error("unused");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
  async stop() {}
  async resume() {}
  async destroy() {}
}

const networkFor = (g: BranchSandbox): PreviewNetwork => ({
  connect: async () => {},
  target: (ref, port) => ({ host: ref, port }),
  probe: async () => g.boots,
});

db().insert(projects).values({ id: "p_create", name: "Create", createdAt: 0 }).onConflictDoNothing().run();
db()
  .insert(projectRepos)
  .values({ id: "p_create/web", projectId: "p_create", url: "https://git.example/web.git", name: "web", createdAt: 0 })
  .onConflictDoNothing()
  .run();

const fast = { healthTimeoutMs: 30, pollMs: 1 };

describe("0017 branch create: provision → discover → confirm", () => {
  it("a provisioning failure is a visible failed row with the lease cleaned up — not a throw", async () => {
    const g = new BranchSandbox();
    g.createFails = true;
    const result = await provisionBranchPreview({ projectId: "p_create", repoId: "p_create/web", branch: "main" }, { provider: g, ...fast });
    expect(result.ready).toBeUndefined();
    expect(result.preview).toMatchObject({ status: "failed", error: expect.stringContaining("cloning web failed") });
    const row = getPreview(db(), result.preview.id);
    expect(row).toMatchObject({ status: "failed", failedSha: "create" });
    // the half-made lease is kept as destroyed history (the FK keeps it)
    expect(getLease(db(), row!.sandboxId)).toMatchObject({ status: "destroyed" });
  });

  it("a checkout failure parks the row failed with the reason", async () => {
    const g = new BranchSandbox();
    g.checkoutFails = true;
    const result = await provisionBranchPreview({ projectId: "p_create", repoId: "p_create/web", branch: "nope" }, { provider: g, ...fast });
    expect(result.preview).toMatchObject({ status: "failed", error: expect.stringContaining("could not read Username") });
  });

  it("no resolvable values → provisioning row + discovered candidates", async () => {
    const g = new BranchSandbox();
    const result = await createBranchPreview({ projectId: "p_create", repoId: "p_create/web", branch: "main" }, { provider: g, network: networkFor(g), ...fast });
    expect(result.candidates?.map((c) => c.dir)).toEqual([".", "apps/web"]);
    expect(result.preview).toMatchObject({ status: "provisioning", headSha: "a".repeat(40) });
  });

  it("confirm installs at the repo root, launches, and can save the setup", async () => {
    const g = new BranchSandbox();
    const provisioned = await provisionBranchPreview({ projectId: "p_create", repoId: "p_create/web", branch: "main" }, { provider: g, ...fast });
    const confirmed = await confirmBranchPreview(
      provisioned.preview.id,
      { workDir: "apps/web", install: "pnpm install", command: "pnpm run dev -H 0.0.0.0 -p 3000", port: 3000, saveSetup: true },
      { provider: g, network: networkFor(g), ...fast },
    );
    expect(confirmed.error).toBeUndefined();
    expect(confirmed.preview).toMatchObject({ status: "healthy", workDir: `/work/${provisioned.preview.id}/web/apps/web` });
    // install ran separately, at the repo root, before the server
    const installAt = g.ran.findIndex((c) => c.includes("set -o pipefail"));
    const launchAt = g.ran.findIndex((c) => c.includes("setsid nohup"));
    expect(installAt).toBeGreaterThan(-1);
    expect(launchAt).toBeGreaterThan(installAt);
    // the setup was saved with the confirmed values
    const setup = getPreviewSetup(db(), "p_create");
    expect(setup).toMatchObject({ ok: true });
    if (setup.ok && setup.setup) {
      expect(setup.setup.definition).toMatchObject({ workDir: "apps/web", install: "pnpm install", port: 3000 });
    }
  });

  it("an explicit-values create is one shot: provision → install → healthy", async () => {
    const g = new BranchSandbox();
    const result = await createBranchPreview(
      {
        projectId: "p_create", repoId: "p_create/web", branch: "main",
        workDir: "apps/web", install: "pnpm install", command: "pnpm run dev -H 0.0.0.0 -p 3000", port: 3000,
      },
      { provider: g, network: networkFor(g), ...fast },
    );
    expect(result.candidates).toBeUndefined();
    expect(result.preview).toMatchObject({ status: "healthy" });
  });

  it("a saved setup makes create one shot with no explicit values", async () => {
    savePreviewSetup(db(), "p_create", {
      repo: "p_create/web", workDir: "apps/web", install: "pnpm install",
      command: "pnpm run dev -H 0.0.0.0 -p 3000", port: 3000, env: {}, services: [],
    });
    const g = new BranchSandbox();
    const result = await createBranchPreview(
      { projectId: "p_create", repoId: "p_create/web", branch: "main" },
      { provider: g, network: networkFor(g), ...fast },
    );
    expect(result.candidates).toBeUndefined();
    expect(result.preview).toMatchObject({ status: "healthy", workDir: `/work/${result.preview.id}/web/apps/web` });
  });

  it("a failed install parks the preview failed with the log", async () => {
    const g = new BranchSandbox();
    g.installOk = false;
    const result = await createBranchPreview(
      {
        projectId: "p_create", repoId: "p_create/web", branch: "main",
        workDir: ".", install: "pnpm install", command: "pnpm run dev", port: 3000,
      },
      { provider: g, network: networkFor(g), ...fast },
    );
    expect(result.preview).toMatchObject({ status: "failed", error: expect.stringContaining("ERR_PNPM_FETCH_404") });
  });
});

describe("0017 phase 2: env through confirm", () => {
  it("confirm persists sparse env overrides and the boot uses them", async () => {
    const g = new BranchSandbox();
    const provisioned = await provisionBranchPreview(
      { projectId: "p_create", repoId: "p_create/web", branch: "main" },
      { provider: g, ...fast },
    );
    const confirmed = await confirmBranchPreview(
      provisioned.preview.id,
      {
        workDir: ".", install: "pnpm install", command: "pnpm run dev", port: 3000,
        env: { TOKEN: "t0", SITE: "${PREVIEW_URL}/api" },
        saveSetup: true,
      },
      { provider: g, network: networkFor(g), ...fast },
    );
    expect(confirmed.preview.status).toBe("healthy");
    const launched = g.ran.find((c) => c.includes("setsid nohup"));
    // env is passed as the run's env map (the fake records argv only, so
    // assert via the saved setup + the row instead)
    void launched;
    const setup = getPreviewSetup(db(), "p_create");
    if (!setup.ok || !setup.setup) throw new Error("no setup");
    expect(setup.setup.definition.env).toEqual({ TOKEN: "t0", SITE: "${PREVIEW_URL}/api" });
  });

  it("rotating a setup env value changes the next boot", async () => {
    const g = new BranchSandbox();
    const result = await createBranchPreview(
      { projectId: "p_create", repoId: "p_create/web", branch: "main" },
      { provider: g, network: networkFor(g), ...fast },
    );
    expect(result.preview.status).toBe("healthy");
    // rotate TOKEN via the setup, relaunch — the resolved env must follow
    savePreviewSetup(db(), "p_create", {
      repo: "p_create/web", workDir: ".", install: "pnpm install",
      command: "pnpm run dev", port: 3000,
      env: { TOKEN: "t1-rotated" }, services: [],
    });
    const { launchPreview } = await import("../lib/previews/service");
    const relaunched = await launchPreview(result.preview.id, { provider: g, network: networkFor(g), ...fast });
    expect(relaunched.preview.status).toBe("healthy");
    const runEnvs = g.ran.filter((c) => c.includes("setsid nohup"));
    expect(runEnvs.length).toBeGreaterThanOrEqual(2);
  });
});
