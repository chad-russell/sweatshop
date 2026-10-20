import { describe, expect, it } from "vitest";
import { db } from "../db";
import {
  getPreview,
  getPreviewBySlug,
  insertPreview,
  makeSlug,
  markPreviewDeleted,
} from "../db/previews";
import { getLease } from "../db/sandboxes";
import { ensureConversation } from "../db/chat";
import { bindConversation } from "../db/sandboxes";
import { projectRepos, projects } from "../db/schema";
import { previewStatusTool, startPreviewTool, stopPreviewTool } from "../lib/agent/tools/previews";
import { previewBaseDomain, previewHost, previewUrl, slugFromHost } from "../lib/previews/network";
import { describeDir, discoverPreviewCandidates } from "../lib/previews/discover";
import { savePreviewSetup } from "../db/preview-setups";
import {
  reconcilePreviews,
  startPreview,
  stopPreview,
} from "../lib/previews/service";
import { makeResolver } from "../lib/previews/runtime";
import { busySandboxIds, destroySandboxNow, reap } from "../lib/sandboxes/reaper";
import { FakeSandbox, fast, networkFor } from "./helpers/fake-sandbox";

/**
 * 0016 previews: the registry, the lifecycle against a scripted sandbox
 * (no podman), reconcile, and the reaper's preview rules. The fake
 * sandbox (tests/helpers/fake-sandbox.ts) models only what the service
 * observes: a pid file per preview that the launch script writes and
 * the kill script removes, plus a scripted "does it answer HTTP" per
 * container.
 */

let n = 0;
function lease(status = "running", ownerKind = "conversation", idleMs = 0, ownerId?: string) {
  n += 1;
  const id = `sbx_pv${n}`;
  db().$client
    .prepare(
      "insert into sandboxes (id, provider, ref, owner_kind, owner_id, status, last_used_at, created_at) " +
        "values (?, 'podman', ?, ?, ?, ?, ?, 0)",
    )
    .run(id, `ref-${id}`, ownerKind, ownerId ?? `owner-${id}`, status, Date.now() - idleMs);
  return id;
}

describe("0016 preview registry", () => {
  it("makes DNS-safe slugs that fit a label", () => {
    const slug = makeSlug("Feat/Login_Flow!! — v2");
    expect(slug).toMatch(/^feat-login-flow-v2-[a-z0-9]{4}$/);
    const long = makeSlug("x".repeat(200));
    expect(`pv-${long}`.length).toBeLessThanOrEqual(63);
    expect(makeSlug(null)).toMatch(/^[a-z0-9]{4}$/);
  });

  it("reads slugs only from pv- hosts", () => {
    expect(slugFromHost("pv-main-ab12.internal.crussell.io")).toBe("main-ab12");
    expect(slugFromHost("pv-main-ab12.internal.crussell.io:443")).toBe("main-ab12");
    expect(slugFromHost("artifacts.internal.crussell.io")).toBeNull();
    expect(slugFromHost(undefined)).toBeNull();
  });

  it("base domain: zero-config previews.localhost fallback, PREVIEW_BASE_DOMAIN override", () => {
    const saved = process.env.PREVIEW_BASE_DOMAIN;
    try {
      delete process.env.PREVIEW_BASE_DOMAIN;
      expect(previewBaseDomain()).toBe("previews.localhost");
      expect(previewHost("main-ab12")).toBe("pv-main-ab12.previews.localhost");
      process.env.PREVIEW_BASE_DOMAIN = "previews.example.com";
      expect(previewBaseDomain()).toBe("previews.example.com");
      expect(previewHost("main-ab12")).toBe("pv-main-ab12.previews.example.com");
      // slugFromHost parses either form's labels identically
      expect(slugFromHost("pv-main-ab12.previews.localhost")).toBe("main-ab12");
      expect(slugFromHost("pv-main-ab12.previews.example.com:443")).toBe("main-ab12");
    } finally {
      if (saved === undefined) delete process.env.PREVIEW_BASE_DOMAIN;
      else process.env.PREVIEW_BASE_DOMAIN = saved;
    }
  });

  it("preview url scheme: http on the localhost fallback, https on a set base, PREVIEW_URL_SCHEME wins", () => {
    const savedBase = process.env.PREVIEW_BASE_DOMAIN;
    const savedScheme = process.env.PREVIEW_URL_SCHEME;
    try {
      delete process.env.PREVIEW_URL_SCHEME;
      // zero-config fallback has no wildcard cert — http
      delete process.env.PREVIEW_BASE_DOMAIN;
      expect(previewUrl("main-ab12")).toBe("http://pv-main-ab12.previews.localhost");
      // a real base domain carries the wildcard cert — https
      process.env.PREVIEW_BASE_DOMAIN = "previews.example.com";
      expect(previewUrl("main-ab12")).toBe("https://pv-main-ab12.previews.example.com");
      // an explicit scheme overrides both defaults
      process.env.PREVIEW_URL_SCHEME = "http";
      expect(previewUrl("main-ab12")).toBe("http://pv-main-ab12.previews.example.com");
      delete process.env.PREVIEW_BASE_DOMAIN;
      process.env.PREVIEW_URL_SCHEME = "https";
      expect(previewUrl("main-ab12")).toBe("https://pv-main-ab12.previews.localhost");
    } finally {
      if (savedBase === undefined) delete process.env.PREVIEW_BASE_DOMAIN;
      else process.env.PREVIEW_BASE_DOMAIN = savedBase;
      if (savedScheme === undefined) delete process.env.PREVIEW_URL_SCHEME;
      else process.env.PREVIEW_URL_SCHEME = savedScheme;
    }
  });

  it("frees a slug when its preview is deleted, keeping the row", () => {
    const sandboxId = lease();
    const p = insertPreview(db(), {
      sandboxId, workDir: "/work/a", command: "x", port: 3000, source: "worktree", startedBy: "user", slug: "reuse-me",
    });
    markPreviewDeleted(db(), p.id);
    expect(getPreviewBySlug(db(), "reuse-me")).toBeNull();
    expect(getPreview(db(), p.id)?.deletedAt).toEqual(expect.any(Number));
    const again = insertPreview(db(), {
      sandboxId, workDir: "/work/a", command: "x", port: 3000, source: "worktree", startedBy: "user", slug: "reuse-me",
    });
    expect(getPreviewBySlug(db(), "reuse-me")?.id).toBe(again.id);
  });
});

describe("0016 preview lifecycle", () => {
  it("starts detached with the preview env, joins the network, and reports healthy", async () => {
    const sbx = new FakeSandbox();
    const network = networkFor(sbx);
    const sandboxId = lease();
    const { preview, log } = await startPreview(
      { sandboxId, workDir: "/work/c1/app", command: "npm run dev", port: 5173, label: "feat/x", source: "worktree", startedBy: "c1" },
      { provider: sbx, network, ...fast },
    );
    expect(preview.status).toBe("healthy");
    expect(log).toBeUndefined();
    expect(preview.url).toMatch(/^http:\/\/pv-feat-x-[a-z0-9]{4}\.previews\.localhost$/);
    expect(network.connected).toEqual([`ref-${sandboxId}`]);
    const launch = sbx.scripts.find((s) => s.command.includes("setsid nohup"))!;
    expect(launch.command).toContain("cd '/work/c1/app'");
    expect(launch.env).toMatchObject({ PORT: "5173", PREVIEW_HOST: preview.host });
  });

  it("is idempotent per (sandbox, dir, port): a second start restarts the same row", async () => {
    const sbx = new FakeSandbox();
    const sandboxId = lease();
    const deps = { provider: sbx, network: networkFor(sbx), ...fast };
    const input = { sandboxId, workDir: "/work/c2", command: "npm run dev", port: 3000, source: "worktree" as const, startedBy: "c2" };
    const a = await startPreview(input, deps);
    const b = await startPreview({ ...input, command: "pnpm dev" }, deps);
    expect(b.preview.id).toBe(a.preview.id);
    expect(b.preview.command).toBe("pnpm dev");
    expect(sbx.scripts.filter((s) => s.command.includes("setsid nohup"))).toHaveLength(2);
  });

  it("returns crashed with the log tail when the process dies", async () => {
    const sbx = new FakeSandbox();
    sbx.behavior = "die";
    const { preview, log } = await startPreview(
      { sandboxId: lease(), workDir: "/work/c3", command: "npm run dev", port: 3000, source: "worktree", startedBy: "c3" },
      { provider: sbx, network: networkFor(sbx), ...fast },
    );
    expect(preview.status).toBe("crashed");
    expect(log).toContain("boom");
  });

  it("stays starting (with a reason) when nothing answers in time", async () => {
    const sbx = new FakeSandbox();
    sbx.behavior = "hang";
    const { preview } = await startPreview(
      { sandboxId: lease(), workDir: "/work/c4", command: "sleep 99", port: 3000, source: "worktree", startedBy: "c4" },
      { provider: sbx, network: networkFor(sbx), ...fast },
    );
    expect(preview.status).toBe("starting");
    expect(preview.error).toMatch(/not answering/);
  });

  it("resumes a stopped sandbox to start a preview; refuses a destroyed one", async () => {
    const sbx = new FakeSandbox();
    const stopped = lease("stopped");
    await startPreview(
      { sandboxId: stopped, workDir: "/work/c5", command: "x", port: 3000, source: "worktree", startedBy: "c5" },
      { provider: sbx, network: networkFor(sbx), ...fast },
    );
    expect(sbx.log).toContain(`resume ref-${stopped}`);
    expect(getLease(db(), stopped)?.status).toBe("running");
    await expect(
      startPreview(
        { sandboxId: lease("destroyed"), workDir: "/work/c5", command: "x", port: 3000, source: "worktree", startedBy: "c5" },
        { provider: sbx, network: networkFor(sbx), ...fast },
      ),
    ).rejects.toMatchObject({ code: "sandbox-gone" });
  });

  it("rejects bad ports and relative directories", async () => {
    const sbx = new FakeSandbox();
    const deps = { provider: sbx, network: networkFor(sbx), ...fast };
    const base = { sandboxId: lease(), command: "x", source: "worktree" as const, startedBy: "c" };
    await expect(startPreview({ ...base, workDir: "/w", port: 0 }, deps)).rejects.toMatchObject({ code: "invalid" });
    await expect(startPreview({ ...base, workDir: "w", port: 3000 }, deps)).rejects.toMatchObject({ code: "invalid" });
  });

  it("stop kills the process and keeps the row", async () => {
    const sbx = new FakeSandbox();
    const deps = { provider: sbx, network: networkFor(sbx), ...fast };
    const { preview } = await startPreview(
      { sandboxId: lease(), workDir: "/work/c6", command: "x", port: 3000, source: "worktree", startedBy: "c6" },
      deps,
    );
    const stopped = await stopPreview(preview.id, deps);
    expect(stopped.status).toBe("stopped");
    expect(sbx.alive.get(preview.id)).toBe(false);
  });
});

describe("0016 reconcile", () => {
  it("corrects rows to what the sandbox reports, never restarting", async () => {
    const sbx = new FakeSandbox();
    const network = networkFor(sbx);
    const deps = { provider: sbx, network, ...fast };
    const sandboxId = lease();
    const { preview } = await startPreview(
      { sandboxId, workDir: "/work/r1", command: "x", port: 3000, source: "worktree", startedBy: "r1" },
      deps,
    );
    sbx.alive.set(preview.id, false);
    sbx.answers.clear();
    await reconcilePreviews(deps);
    expect(getPreview(db(), preview.id)).toMatchObject({ status: "crashed", error: "process exited" });
    expect(sbx.scripts.filter((s) => s.command.includes("setsid nohup"))).toHaveLength(1);
  });

  it("marks previews in a sandbox that is no longer running as stopped", async () => {
    const sbx = new FakeSandbox();
    const sandboxId = lease("stopped");
    const p = insertPreview(db(), { sandboxId, workDir: "/w", command: "x", port: 3000, source: "worktree", startedBy: "u" });
    await reconcilePreviews({ provider: sbx, network: networkFor(sbx) });
    expect(getPreview(db(), p.id)?.status).toBe("stopped");
  });
});

describe("0016 reaper", () => {
  it("a serving preview keeps its sandbox busy", async () => {
    const sbx = new FakeSandbox();
    const sandboxId = lease("running", "conversation", 45 * 60_000);
    await startPreview(
      { sandboxId, workDir: "/work/g1", command: "x", port: 3000, source: "worktree", startedBy: "g1" },
      { provider: sbx, network: networkFor(sbx), ...fast },
    );
    // starting a preview is use; age the lease again past the chat window
    db().$client.prepare("update sandboxes set last_used_at = ? where id = ?").run(Date.now() - 45 * 60_000, sandboxId);
    expect(busySandboxIds([sandboxId]).has(sandboxId)).toBe(true);
    await reap({ apply: true, provider: sbx });
    expect(getLease(db(), sandboxId)?.status).toBe("running");
  });

  it("stops a preview idle past GC_PREVIEW_STOP_HOURS, then the sandbox reaps normally", async () => {
    const sbx = new FakeSandbox();
    const sandboxId = lease("running", "conversation", 45 * 60_000);
    const p = insertPreview(db(), { sandboxId, workDir: "/w", command: "x", port: 3000, source: "worktree", startedBy: "u" });
    const old = Date.now() - 13 * 3_600_000;
    db().$client.prepare("update previews set status = 'healthy', updated_at = ?, last_request_at = ? where id = ?").run(old, old, p.id);
    const report = await reap({ apply: true, provider: sbx });
    expect(report.actions).toContainEqual(expect.objectContaining({ sandboxId, action: "stop-preview" }));
    expect(getPreview(db(), p.id)?.status).toBe("stopped");
    expect(getLease(db(), sandboxId)?.status).toBe("stopped");
  });

  it("destroying a sandbox marks its previews stopped", async () => {
    const sbx = new FakeSandbox();
    const sandboxId = lease();
    const p = insertPreview(db(), { sandboxId, workDir: "/w", command: "x", port: 3000, source: "worktree", startedBy: "u" });
    await destroySandboxNow(sandboxId, sbx).catch(() => undefined);
    // busy (starting) blocks a manual destroy — stop it first, as the UI does
    db().$client.prepare("update previews set status = 'crashed' where id = ?").run(p.id);
    await destroySandboxNow(sandboxId, sbx);
    expect(getPreview(db(), p.id)?.status).toBe("stopped");
  });
});

describe("0016 proxy resolution", () => {
  it("routes live previews to their container and reports down ones", () => {
    const sbx = new FakeSandbox();
    const sandboxId = lease();
    insertPreview(db(), { sandboxId, workDir: "/w", command: "x", port: 4321, source: "worktree", startedBy: "u", slug: "res-live" });
    const down = insertPreview(db(), { sandboxId, workDir: "/w2", command: "x", port: 4322, source: "worktree", startedBy: "u", slug: "res-down" });
    db().$client.prepare("update previews set status = 'crashed' where id = ?").run(down.id);
    const resolve = makeResolver(networkFor(sbx));
    expect(resolve("res-live")).toMatchObject({ kind: "ok", host: `ref-${sandboxId}`, port: 4321 });
    expect(resolve("res-down")).toMatchObject({ kind: "down", status: "crashed" });
    // a failed branch preview still serves its last good commit
    const kept = insertPreview(db(), { sandboxId, workDir: "/w3", command: "x", port: 4323, source: "branch", startedBy: "u", slug: "res-kept" });
    db().$client.prepare("update previews set status = 'failed' where id = ?").run(kept.id);
    expect(makeResolver(networkFor(sbx))("res-kept")).toMatchObject({ kind: "ok", port: 4323 });
    expect(resolve("nope")).toEqual({ kind: "missing" });
  });
});

describe("0017 discovery", () => {
  const scanHandle = (scan: string) => {
    const sbx = new FakeSandbox();
    sbx.files.set("scan", scan);
    return sbx.attach("ref-discover");
  };

  const scan = [
    "__ROOT__",
    '{"scripts":{"dev":"turbo dev"}}',
    "__LOCKS__",
    "pnpm-lock.yaml",
    "__PKGS__",
    "__PKG__apps/web",
    '{"scripts":{"dev":"next dev"}}',
    "__PKG__apps/api",
    '{"scripts":{"start":"tsx src/index.ts"}}',
    "__PKG__apps/docs",
    '{"scripts":{"build":"x"}}',
    "__END__",
    "",
  ].join("\n");

  it("lists the root and every subpackage with a dev/start script, prefilled", async () => {
    const candidates = await discoverPreviewCandidates(scanHandle(scan), "/work/x");
    expect(candidates.map((c) => c.dir)).toEqual([".", "apps/web", "apps/api"]);
    expect(candidates[0]).toMatchObject({ pm: "pnpm", script: "dev", install: "pnpm install", port: 3000 });
    // plain body (turbo): no framework flags
    expect(candidates[0]!.command).toBe("pnpm run dev");
    // next gets host/port flags, pnpm needs no `--`
    expect(candidates[1]!.command).toBe("pnpm run dev -H 0.0.0.0 -p 3000");
    // a start-only package still qualifies
    expect(candidates[2]).toMatchObject({ script: "start" });
  });

  it("describes one directory for the agent tool, npm `--` and all", async () => {
    const sbx = new FakeSandbox();
    sbx.files.set("listing", `{"scripts":{"dev":"next dev"}}\n__\npackage-lock.json\n`);
    const described = await describeDir(sbx.attach("r"), "/w");
    expect(described).toEqual({
      command: "npm run dev -- -H 0.0.0.0 -p 3000",
      port: 3000,
      install: "npm install",
    });
  });

  it("explains what is missing instead of guessing", async () => {
    const sbx = new FakeSandbox();
    sbx.files.set("listing", `\n__\n`);
    expect(await describeDir(sbx.attach("r"), "/w")).toMatchObject({
      error: expect.stringMatching(/package.json/),
    });
    sbx.files.set("listing", `{"scripts":{"build":"x"}}\n__\n`);
    expect(await describeDir(sbx.attach("r"), "/w")).toMatchObject({
      error: expect.stringMatching(/no dev or start/),
    });
  });
});

describe("0016 preview tools", () => {
  function boundChat(id: string, projectId: string | null = null) {
    const sandboxId = lease("running", "conversation", 0, id);
    ensureConversation(db(), id, projectId);
    bindConversation(db(), id, { kind: "bound", sandboxId, workDir: `/work/${id}`, owner: true });
    return sandboxId;
  }

  it("start_preview discovers the command in the binding's only repo and reports the url", async () => {
    const sbx = new FakeSandbox();
    sbx.files.set("listing", `{"scripts":{"dev":"vite"}}\n__\npnpm-lock.yaml\n`);
    const sandboxId = boundChat("c_pvtool");
    const realAttach = sbx.attach.bind(sbx);
    sbx.attach = (ref: string) => {
      const h = realAttach(ref);
      return {
        ...h,
        run: async (command, env, cwd) =>
          command.includes(".git") ? { exitCode: 0, stdout: "web\n", stderr: "" } : h.run(command, env, cwd),
      };
    };
    const result = await startPreviewTool(
      { kind: "conversation", conversationId: "c_pvtool" },
      { label: "web" },
      { provider: sbx, network: networkFor(sbx), ...fast },
    );
    expect(result).toMatchObject({ ok: true, preview: { status: "healthy", workDir: "/work/c_pvtool/web", port: 3000, sandboxId } });
    if (!result.ok) throw new Error("unreachable");
    expect(result.preview.command).toContain("pnpm run dev --host 0.0.0.0 --port 3000");
    expect(result.preview.startedBy).toBe("c_pvtool");
  });

  it("a saved setup is the default: its repo+workDir and command/port, no discovery", async () => {
    db().insert(projects).values({ id: "p_tools", name: "Tools", createdAt: 0 }).onConflictDoNothing().run();
    db()
      .insert(projectRepos)
      .values({ id: "p_tools/web", projectId: "p_tools", url: "https://git.example/web.git", name: "web", createdAt: 0 })
      .onConflictDoNothing()
      .run();
    savePreviewSetup(db(), "p_tools", {
      repo: "p_tools/web", workDir: "apps/web", install: "pnpm install",
      command: "pnpm run dev -H 0.0.0.0 -p $PORT", port: 4321, env: {}, services: [],
    });
    const sbx = new FakeSandbox();
    ensureConversation(db(), "c_pvsetup", "p_tools");
    bindConversation(db(), "c_pvsetup", { kind: "bound", sandboxId: lease(), workDir: "/work/c_pvsetup", owner: true });
    const result = await startPreviewTool(
      { kind: "conversation", conversationId: "c_pvsetup" },
      { label: "setup" },
      { provider: sbx, network: networkFor(sbx), ...fast },
    );
    expect(result).toMatchObject({
      ok: true,
      preview: { workDir: "/work/c_pvsetup/web/apps/web", port: 4321, command: "pnpm run dev -H 0.0.0.0 -p $PORT" },
    });
  });

  it("start_preview delivers setup env + overrides + platform, platform final", async () => {
    db().insert(projects).values({ id: "p_envd", name: "EnvD", createdAt: 0 }).onConflictDoNothing().run();
    db()
      .insert(projectRepos)
      .values({ id: "p_envd/web", projectId: "p_envd", url: "https://git.example/web.git", name: "web", createdAt: 0 })
      .onConflictDoNothing()
      .run();
    savePreviewSetup(db(), "p_envd", {
      repo: "p_envd/web", workDir: ".", install: "npm install", command: "npm run dev",
      port: 3000,
      env: { SHARED: "setup", OVERRIDDEN: "setup", SITE: "${PREVIEW_URL}/x" },
      services: [],
    });
    const sbx = new FakeSandbox();
    boundChat("c_pvenv", "p_envd");
    const result = await startPreviewTool(
      { kind: "conversation", conversationId: "c_pvenv" },
      { env: { OVERRIDDEN: "per-preview", EXTRA: "yes" } },
      { provider: sbx, network: networkFor(sbx), ...fast },
    );
    expect(result).toMatchObject({ ok: true });
    // the launch script's env: merged layers, platform last
    const launched = sbx.scripts.find((s) => s.command.includes("setsid nohup"));
    expect(launched?.env).toMatchObject({
      SHARED: "setup",
      OVERRIDDEN: "per-preview",
      EXTRA: "yes",
      SITE: expect.stringContaining("http://pv-"),
      PORT: "3000",
      HOST: "0.0.0.0",
    });
    // the debug .env file is written (quoted KEY=VALUE lines, 0600)
    expect(launched?.command).toContain(".env");
    expect(launched?.command).toContain("chmod 600");
  });

  it("a bad env reference parks the preview failed instead of launching", async () => {
    db().insert(projects).values({ id: "p_envb", name: "EnvB", createdAt: 0 }).onConflictDoNothing().run();
    db()
      .insert(projectRepos)
      .values({ id: "p_envb/web", projectId: "p_envb", url: "https://git.example/web.git", name: "web", createdAt: 0 })
      .onConflictDoNothing()
      .run();
    savePreviewSetup(db(), "p_envb", {
      repo: "p_envb/web", workDir: ".", install: "npm install", command: "npm run dev",
      port: 3000, env: { BAD: "${service:db:5432}" }, services: [],
    });
    const sbx = new FakeSandbox();
    boundChat("c_pvbad", "p_envb");
    const result = await startPreviewTool(
      { kind: "conversation", conversationId: "c_pvbad" },
      {},
      { provider: sbx, network: networkFor(sbx), ...fast },
    );
    // the launch itself did not happen — the row parks failed with the reason
    expect(sbx.scripts.some((s) => s.command.includes("setsid nohup"))).toBe(false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview.status).toBe("failed");
      expect(result.preview.error).toContain("service");
    }
  });

  it("status lists the sandbox's previews without binding; stop refuses other sandboxes'", async () => {
    const sbx = new FakeSandbox();
    const deps = { provider: sbx, network: networkFor(sbx), ...fast };
    boundChat("c_pvmine");
    const started = await startPreviewTool({ kind: "conversation", conversationId: "c_pvmine" }, { command: "x", port: 8080 }, deps);
    if (!started.ok) throw new Error(started.message);
    const listed = await previewStatusTool({ kind: "conversation", conversationId: "c_pvmine" }, {}, deps);
    expect(listed).toMatchObject({ ok: true, previews: [{ id: started.preview.id }] });

    ensureConversation(db(), "c_pvunbound");
    expect(await previewStatusTool({ kind: "conversation", conversationId: "c_pvunbound" }, {}, deps)).toEqual({ ok: true, previews: [] });

    boundChat("c_pvother");
    const denied = await stopPreviewTool({ kind: "conversation", conversationId: "c_pvother" }, { id: started.preview.id }, deps);
    expect(denied).toMatchObject({ ok: false, code: "not-yours" });
    const stopped = await stopPreviewTool({ kind: "conversation", conversationId: "c_pvmine" }, { id: started.preview.id }, deps);
    expect(stopped).toMatchObject({ ok: true, preview: { status: "stopped" } });
  });

  it("errors are values the model can act on", async () => {
    const sbx = new FakeSandbox();
    sbx.files.set("listing", `\n__\n`);
    boundChat("c_pvnopkg");
    const result = await startPreviewTool(
      { kind: "conversation", conversationId: "c_pvnopkg" },
      { dir: "/work/c_pvnopkg" },
      { provider: sbx, network: networkFor(sbx), ...fast },
    );
    expect(result).toMatchObject({ ok: false, code: "no-command", message: expect.stringContaining("package.json") });
  });
});
