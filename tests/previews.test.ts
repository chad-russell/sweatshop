import type { Experimental_SandboxSession } from "ai";
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
import { previewStatusTool, startPreviewTool, stopPreviewTool } from "../lib/agent/tools/previews";
import { slugFromHost } from "../lib/previews/network";
import type { PreviewNetwork } from "../lib/previews/network";
import {
  inferPreviewCommand,
  reconcilePreviews,
  startPreview,
  stopPreview,
} from "../lib/previews/service";
import { makeResolver } from "../lib/previews/runtime";
import { busySandboxIds, destroySandboxNow, reap } from "../lib/sandboxes/reaper";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";

/**
 * 0016 previews: the registry, the lifecycle against a scripted sandbox
 * (no podman), reconcile, and the reaper's preview rules. The fake
 * sandbox models only what the service observes: a pid file per preview
 * that the launch script writes and the kill script removes, plus a
 * scripted "does it answer HTTP" per container.
 */

class FakeSandbox implements SandboxProvider {
  readonly kind = "podman";
  /** preview id → alive */
  alive = new Map<string, boolean>();
  /** ref:port → answers HTTP */
  answers = new Set<string>();
  /** What a launch does: "serve" comes up, "die" exits at once, "hang" never answers. */
  behavior: "serve" | "die" | "hang" = "serve";
  scripts: { command: string; env?: Record<string, string> }[] = [];
  files = new Map<string, string>();
  log: string[] = [];
  async create(): Promise<SandboxHandle> {
    throw new Error("unused");
  }
  attach(ref: string): SandboxHandle {
    return {
      ref,
      run: async (command, env) => {
        this.scripts.push({ command, ...(env ? { env } : {}) });
        const pidMatch = /\/work\/\.previews\/(pv_[A-Za-z0-9_-]+)\.pid/.exec(command);
        const id = pidMatch?.[1];
        if (command.includes("setsid nohup") && id) {
          const port = env?.PORT ?? "0";
          this.alive.set(id, this.behavior !== "die");
          if (this.behavior === "serve") this.answers.add(`${ref}:${port}`);
          else this.answers.delete(`${ref}:${port}`);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command.includes("kill -TERM") && id) {
          this.alive.set(id, false);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command.includes("echo alive") && id) {
          return { exitCode: 0, stdout: this.alive.get(id) ? "alive\n" : "", stderr: "" };
        }
        if (command.startsWith("tail -n")) return { exitCode: 0, stdout: "boom: missing module\n", stderr: "" };
        if (command.startsWith("cat package.json")) {
          return { exitCode: 0, stdout: this.files.get("listing") ?? "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: (() => {
        throw new Error("unused");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
  async stop(ref: string) {
    this.log.push(`stop ${ref}`);
  }
  async resume(ref: string) {
    this.log.push(`resume ${ref}`);
  }
  async destroy(ref: string) {
    this.log.push(`destroy ${ref}`);
  }
}

function networkFor(sbx: FakeSandbox): PreviewNetwork & { connected: string[] } {
  const connected: string[] = [];
  return {
    connected,
    async connect(ref) {
      connected.push(ref);
    },
    target: (ref, port) => ({ host: ref, port }),
    probe: async (ref, port) => sbx.answers.has(`${ref}:${port}`),
  };
}

let n = 0;
function lease(status = "running", ownerKind = "conversation", idleMs = 0) {
  n += 1;
  const id = `sbx_pv${n}`;
  db().$client
    .prepare(
      "insert into sandboxes (id, provider, ref, owner_kind, owner_id, status, last_used_at, created_at) " +
        "values (?, 'podman', ?, ?, ?, ?, ?, 0)",
    )
    .run(id, `ref-${id}`, ownerKind, `owner-${id}`, status, Date.now() - idleMs);
  return id;
}

const fast = { healthTimeoutMs: 30, pollMs: 1 };

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
    expect(preview.url).toMatch(/^https:\/\/pv-feat-x-[a-z0-9]{4}\.internal\.crussell\.io$/);
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
    expect(resolve("nope")).toEqual({ kind: "missing" });
  });
});

describe("0016 command inference", () => {
  const handleWith = (listing: string) => {
    const sbx = new FakeSandbox();
    sbx.files.set("listing", listing);
    return sbx.attach("ref-infer");
  };

  it("uses the lockfile's package manager and framework host flags", async () => {
    const vite = await inferPreviewCommand(
      handleWith(`{"scripts":{"dev":"vite"}}\n---\npnpm-lock.yaml\n`),
      "/work/x",
    );
    expect(vite).toEqual({ command: "[ -d node_modules ] || pnpm install && pnpm run dev --host 0.0.0.0 --port 3000", port: 3000 });
    const next = await inferPreviewCommand(handleWith(`{"scripts":{"dev":"next dev"}}\n---\npackage-lock.json\n`), "/w");
    expect(next).toEqual({ command: "[ -d node_modules ] || npm install && npm run dev -- -H 0.0.0.0 -p 3000", port: 3000 });
  });

  it("explains what is missing instead of guessing", async () => {
    expect(await inferPreviewCommand(handleWith(`\n---\n`), "/w")).toMatchObject({ error: expect.stringMatching(/package.json/) });
    expect(await inferPreviewCommand(handleWith(`{"scripts":{"build":"x"}}\n---\n`), "/w")).toMatchObject({
      error: expect.stringMatching(/no dev or start/),
    });
  });
});

describe("0016 preview tools", () => {
  function boundChat(id: string) {
    const sandboxId = lease();
    ensureConversation(db(), id);
    bindConversation(db(), id, { kind: "bound", sandboxId, workDir: `/work/${id}`, owner: true });
    return sandboxId;
  }

  it("start_preview infers the command in the binding's only repo and reports the url", async () => {
    const sbx = new FakeSandbox();
    sbx.files.set("listing", `{"scripts":{"dev":"vite"}}\n---\npnpm-lock.yaml\n`);
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
    sbx.files.set("listing", `\n---\n`);
    boundChat("c_pvnopkg");
    const result = await startPreviewTool(
      { kind: "conversation", conversationId: "c_pvnopkg" },
      { dir: "/work/c_pvnopkg" },
      { provider: sbx, network: networkFor(sbx), ...fast },
    );
    expect(result).toMatchObject({ ok: false, code: "no-command", message: expect.stringContaining("package.json") });
  });
});
