import type { Experimental_SandboxSession } from "ai";
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { getPreview, insertPreview, updatePreview } from "../db/previews";
import { getLease } from "../db/sandboxes";
import { listSandboxServices } from "../db/sandbox-services";
import { savePreviewSetup } from "../db/preview-setups";
import { projectRepos, projects } from "../db/schema";
import { launchPreview, resolvedEnvFor } from "../lib/previews/service";
import { resolvePreviewEnv } from "../lib/previews/env";
import {
  ensureSandboxServices,
  serviceContainerName,
  type DockerRunner,
} from "../lib/sandboxes/services";
import type { PreviewNetwork } from "../lib/previews/network";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";

/**
 * 0017 phase 3: declared services — the substrate seam against a
 * scripted docker runner (no podman), the launch ordering (ensure →
 * ready → provision-once → start), env interpolation through the
 * resolver, and the dies-with-sandbox contract.
 */

db().insert(projects).values({ id: "p_svc", name: "Svc", createdAt: 0 }).onConflictDoNothing().run();
db()
  .insert(projectRepos)
  .values({ id: "p_svc/web", projectId: "p_svc", url: "https://git.example/web.git", name: "web", createdAt: 0 })
  .onConflictDoNothing()
  .run();

const SERVICES = [
  { name: "db", image: "docker.io/library/postgres:18-alpine", env: { POSTGRES_PASSWORD: "postgres" }, port: 5432 },
];

/** Records every docker invocation; fails the named ones on demand. */
class FakeDocker {
  calls: string[][] = [];
  failRun = false;
  runner: DockerRunner = async (args) => {
    this.calls.push(args);
    if (this.failRun && args[0] === "run") throw new Error("pull policy denied");
  };
  ran(sub: string): boolean {
    return this.calls.some((a) => a.join(" ").includes(sub));
  }
}

class ServiceSandbox implements SandboxProvider {
  readonly kind = "podman";
  ran: string[] = [];
  provisionRuns = 0;
  constructor(readonly probesReady = true) {}
  async create(): Promise<SandboxHandle> {
    throw new Error("unused");
  }
  attach(ref: string): SandboxHandle {
    return {
      ref,
      run: async (command) => {
        this.ran.push(command);
        const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
        if (command.includes("/dev/tcp")) return ok(this.probesReady ? "ready" : "");
        if (command.includes("pnpm -w run migrate")) {
          this.provisionRuns += 1;
          return ok("migrated");
        }
        if (command.includes("setsid nohup")) return ok();
        if (command.includes("echo alive")) return ok("alive\n");
        if (command.startsWith("tail -n")) return ok("server up\n");
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

const networkFor = (): PreviewNetwork => ({
  connect: async () => {},
  target: (ref, port) => ({ host: ref, port }),
  probe: async () => true,
});

let n = 0;
function servicePreviewFixture(): { previewId: string; sandboxId: string } {
  n += 1;
  const previewId = `pv_svc${n}`;
  const sandboxId = `sbx_svc${n}`;
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
    label: "svc-test",
    source: "branch",
    repoId: "p_svc/web",
    branch: "main",
    startedBy: "user",
    env: { DATABASE_URL: "postgres://postgres:postgres@${service:db:5432}/app" },
  });
  updatePreview(db(), previewId, { status: "stopped", headSha: "a".repeat(40) });
  return { previewId, sandboxId };
}

const setupWithServices = (provision?: string) =>
  savePreviewSetup(db(), "p_svc", {
    repo: "p_svc/web",
    workDir: ".",
    install: "pnpm install",
    ...(provision ? { provision } : {}),
    command: "pnpm run dev",
    port: 3000,
    env: {},
    services: SERVICES,
  });

const fast = { healthTimeoutMs: 30, pollMs: 1, serviceProbeMs: 50 };

describe("0017 env × services", () => {
  it("interpolates service refs through the resolver", () => {
    const platform = { PORT: "3000", HOST: "0.0.0.0", PREVIEW_HOST: "h", PREVIEW_URL: "u" };
    const ok = resolvePreviewEnv(
      { DATABASE_URL: "postgres@${service:db:5432}", ALIAS: "${service:db}" },
      null,
      platform,
      (name) => (name === "db" ? { address: "ref-1-svc-db" } : { error: "no such service" }),
    );
    expect(ok).toEqual({ env: { DATABASE_URL: "postgres@ref-1-svc-db:5432", ALIAS: "ref-1-svc-db" } });
  });

  it("a not-running service is a value-shaped error naming it", () => {
    const r = resolvePreviewEnv({ X: "${service:db:5432}" }, null, {}, (name) => ({
      error: `service ${name} is stopped`,
    }));
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("service db is stopped");
  });
});

describe("0017 ensureSandboxServices", () => {
  it("creates sibling containers on the harness network, idempotently", async () => {
    const { sandboxId } = servicePreviewFixture();
    const docker = new FakeDocker();
    await ensureSandboxServices(sandboxId, SERVICES, { docker: docker.runner });
    const run = docker.calls.find((a) => a[0] === "run")!;
    expect(run).toContain("-d");
    expect(run.join(" ")).toContain("--network sweatshop-harness");
    expect(run.join(" ")).toContain("--name ref-" + sandboxId + "-svc-db");
    expect(run).toContain("-e");
    expect(run).toContain("POSTGRES_PASSWORD=postgres");
    expect(listSandboxServices(db(), sandboxId)).toMatchObject([{ name: "db", status: "running", port: 5432 }]);

    // second ensure: `docker start` no-op, no re-run
    await ensureSandboxServices(sandboxId, SERVICES, { docker: docker.runner });
    expect(docker.calls.filter((a) => a[0] === "run")).toHaveLength(1);
  });

  it("a failed start is an error and the row parks stopped", async () => {
    const { sandboxId } = servicePreviewFixture();
    const docker = new FakeDocker();
    docker.failRun = true;
    await expect(ensureSandboxServices(sandboxId, SERVICES, { docker: docker.runner })).rejects.toThrow(
      /service db .*failed to start/,
    );
    expect(listSandboxServices(db(), sandboxId)).toMatchObject([{ name: "db", status: "stopped" }]);
  });

  it("container names stay DNS labels for long refs", () => {
    const long = "sweatshop-sbx-" + "x".repeat(60);
    const name = serviceContainerName(long, "db");
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toContain("-svc-db-");
  });
});

describe("0017 launch with services", () => {
  it("ensure → readiness → provision-once → start, with the service address in env", async () => {
    const { previewId, sandboxId } = servicePreviewFixture();
    setupWithServices("pnpm -w run migrate");
    const docker = new FakeDocker();
    const sbx = new ServiceSandbox(true);
    const result = await launchPreview(previewId, {
      provider: sbx,
      network: networkFor(),
      services: { docker: docker.runner },
      ...fast,
    });
    expect(result.preview.status).toBe("healthy");
    // ordering: service ran before the server, provision before the server
    const provisionAt = sbx.ran.findIndex((c) => c.includes("pnpm -w run migrate"));
    const startAt = sbx.ran.findIndex((c) => c.includes("setsid nohup"));
    expect(provisionAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(provisionAt);
    // the env handed to the launch carries the resolved service address
    // (values are shell-quoted inside the file content — assert pieces)
    const envFile = sbx.ran.find((c) => c.includes(".env") && c.includes("printf"));
    expect(envFile).toContain("DATABASE_URL=");
    expect(envFile).toContain(`@ref-${sandboxId}-svc-db:5432/app`);
    // provision runs ONCE per sandbox
    const again = await launchPreview(previewId, {
      provider: sbx,
      network: networkFor(),
      services: { docker: docker.runner },
      ...fast,
    });
    expect(again.preview.status).toBe("healthy");
    expect(sbx.provisionRuns).toBe(1);
    expect(getLease(db(), sandboxId)?.servicesProvisionedAt).toBeGreaterThan(0);
  });

  it("a service that never answers parks the preview failed, named", async () => {
    const { previewId } = servicePreviewFixture();
    setupWithServices();
    const sbx = new ServiceSandbox(false);
    const result = await launchPreview(previewId, {
      provider: sbx,
      network: networkFor(),
      services: { docker: new FakeDocker().runner },
      ...fast,
    });
    expect(result.preview.status).toBe("failed");
    expect(result.preview.error).toContain("service db never answered on 5432");
    expect(sbx.ran.some((c) => c.includes("setsid nohup"))).toBe(false);
  });
});

describe("0017 services die with the sandbox", () => {
  it("destroy removes the containers and closes the rows", async () => {
    const { previewId, sandboxId } = servicePreviewFixture();
    void previewId;
    const docker = new FakeDocker();
    await ensureSandboxServices(sandboxId, SERVICES, { docker: docker.runner });
    const { destroySandbox } = await import("../lib/sandboxes/lease");
    await destroySandbox(sandboxId, {
      ...new ServiceSandbox(),
      destroy: async () => {},
    } as unknown as SandboxProvider);
    expect(docker.ran(`rm -f ref-${sandboxId}-svc-db`)).toBe(true);
    expect(listSandboxServices(db(), sandboxId)).toMatchObject([{ name: "db", status: "destroyed" }]);
  });
});

describe("0017 resolvedEnvFor wiring", () => {
  it("resolves through the registry when the service is running", async () => {
    const { previewId, sandboxId } = servicePreviewFixture();
    await ensureSandboxServices(sandboxId, SERVICES, { docker: new FakeDocker().runner });
    const p = getPreview(db(), previewId)!;
    const resolved = resolvedEnvFor(p);
    expect(resolved).toEqual({
      env: expect.objectContaining({
        DATABASE_URL: `postgres://postgres:postgres@ref-${sandboxId}-svc-db:5432/app`,
      }),
    });
  });
});

describe("0017 service command args", () => {
  it("splits compose-style commands into argv, quotes respected", async () => {
    const { splitArgs } = await import("../lib/sandboxes/services");
    expect(splitArgs("server /data --console-address :9001")).toEqual([
      "server",
      "/data",
      "--console-address",
      ":9001",
    ]);
    expect(splitArgs(`run --flag "two words" 'x y'`)).toEqual(["run", "--flag", "two words", "x y"]);
    expect(splitArgs("")).toEqual([]);
  });

  it("passes the command as entrypoint argv, not a shell line", async () => {
    const { sandboxId } = servicePreviewFixture();
    const docker = new FakeDocker();
    await ensureSandboxServices(
      sandboxId,
      [{ name: "s3", image: "docker.io/minio/minio", command: "server /data", env: {}, port: 9000 }],
      { docker: docker.runner },
    );
    const run = docker.calls.find((a) => a[0] === "run")!;
    const imageAt = run.indexOf("docker.io/minio/minio");
    expect(run.slice(imageAt + 1)).toEqual(["server", "/data"]);
    expect(run).not.toContain("bash");
  });
});
