import type { Experimental_SandboxSession } from "ai";
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { loadAttention, loadInbox } from "../db/attention";
import { getPreview, insertPreview, listPreviewEvents, updatePreview } from "../db/previews";
import { deletePreviewSetup, savePreviewSetup } from "../db/preview-setups";
import { projectRepos, projects } from "../db/schema";
import {
  dependenciesChanged,
  dismissPreviewFailure,
  followPreview,
  retryPreview,
} from "../lib/previews/branch";
import type { PreviewNetwork } from "../lib/previews/network";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";

/**
 * 0016 phase 3: the branch follower against a scripted git sandbox — no
 * podman, no network. The fake models a remote head, the checkout's
 * HEAD, whether a move is a fast-forward, which files a diff touches,
 * whether install succeeds, and whether the server comes up.
 */

class GitSandbox implements SandboxProvider {
  readonly kind = "podman";
  remote = "a".repeat(40);
  head = "a".repeat(40);
  fastForward = true;
  changed = "src/app.tsx";
  installOk = true;
  boots = true;
  fetchOk = true;
  alive = true;
  ran: string[] = [];
  async create(): Promise<SandboxHandle> {
    throw new Error("unused");
  }
  attach(ref: string): SandboxHandle {
    return {
      ref,
      run: async (command) => {
        this.ran.push(command);
        const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
        const no = (stderr: string) => ({ exitCode: 1, stdout: "", stderr });
        if (command.startsWith("git fetch")) return this.fetchOk ? ok(`${this.remote}\n`) : no("could not resolve host");
        if (command.startsWith("git diff --name-only")) return ok(`${this.changed}\n`);
        if (command.startsWith("git merge --ff-only")) {
          if (!this.fastForward) return no("Not possible to fast-forward");
          this.head = this.remote;
          return ok();
        }
        if (command.startsWith("git reset --hard")) {
          this.head = this.remote;
          return ok();
        }
        if (command.startsWith("ls -1a")) return ok("package.json\npnpm-lock.yaml\nsrc\n");
        if (command.includes("pnpm install")) return this.installOk ? ok("done") : no("ERR_PNPM_FETCH_404 left-pad");
        if (command.includes("setsid nohup")) {
          this.alive = this.boots;
          return ok();
        }
        if (command.includes("kill -TERM")) {
          this.alive = false;
          return ok();
        }
        if (command.includes("echo alive")) return ok(this.alive ? "alive\n" : "");
        if (command.startsWith("tail -n")) return ok("Error: Cannot find module 'left-pad'\n");
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

function networkFor(g: GitSandbox): PreviewNetwork {
  return { connect: async () => {}, target: (ref, port) => ({ host: ref, port }), probe: async () => g.alive };
}

db().insert(projects).values({ id: "p_follow", name: "Follow", createdAt: 0 }).onConflictDoNothing().run();
db()
  .insert(projectRepos)
  .values({ id: "p_follow/web", projectId: "p_follow", url: "https://git.example/web.git", name: "web", createdAt: 0 })
  .onConflictDoNothing()
  .run();

let n = 0;
/** A healthy branch preview at sha `a…`, in a running preview-owned
 *  sandbox, with the project's setup saved (0017: the follower
 *  reinstalls from setup.install). */
function branchPreview(head = "a".repeat(40), withSetup = true) {
  n += 1;
  const sandboxId = `sbx_follow${n}`;
  const id = `pv_follow${n}`;
  db().$client
    .prepare(
      "insert into sandboxes (id, provider, ref, owner_kind, owner_id, status, last_used_at, created_at) " +
        "values (?, 'podman', ?, 'preview', ?, 'running', ?, 0)",
    )
    .run(sandboxId, `ref-${sandboxId}`, id, Date.now());
  insertPreview(db(), {
    id, sandboxId, workDir: `/work/${id}/web`, command: "pnpm dev", port: 3000, label: "feat/x",
    source: "branch", repoId: "p_follow/web", branch: "feat/x", startedBy: "user",
  });
  updatePreview(db(), id, { status: "healthy", headSha: head });
  if (withSetup) {
    savePreviewSetup(db(), "p_follow", {
      repo: "p_follow/web", workDir: ".", install: "pnpm install",
      command: "pnpm dev", port: 3000, env: {}, services: [],
    });
  } else {
    deletePreviewSetup(db(), "p_follow");
  }
  return id;
}

const fast = { healthTimeoutMs: 20, pollMs: 1 };
const sha = (c: string) => c.repeat(40);

describe("0016 follower", () => {
  it("does nothing while the remote has not moved", async () => {
    const g = new GitSandbox();
    const id = branchPreview();
    const r = await followPreview(getPreview(db(), id)!, { provider: g, network: networkFor(g), ...fast });
    expect(r.action).toBe("unchanged");
    expect(g.ran.filter((c) => c.startsWith("git merge"))).toHaveLength(0);
  });

  it("fast-forwards a source-only change and lets the dev server reload", async () => {
    const g = new GitSandbox();
    const id = branchPreview();
    g.remote = sha("b");
    const r = await followPreview(getPreview(db(), id)!, { provider: g, network: networkFor(g), ...fast });
    expect(r).toMatchObject({ action: "reloaded", sha: sha("b") });
    expect(getPreview(db(), id)).toMatchObject({ headSha: sha("b"), status: "healthy" });
    expect(g.ran.some((c) => c.includes("setsid nohup"))).toBe(false);
    expect(listPreviewEvents(db(), id)[0]).toMatchObject({ sha: sha("b"), result: "reloaded" });
  });

  it("reinstalls and restarts when dependencies changed", async () => {
    const g = new GitSandbox();
    const id = branchPreview();
    g.remote = sha("c");
    g.changed = "src/a.ts\npnpm-lock.yaml";
    const r = await followPreview(getPreview(db(), id)!, { provider: g, network: networkFor(g), ...fast });
    expect(r.action).toBe("deployed");
    expect(g.ran.some((c) => c.includes("pnpm install"))).toBe(true);
    expect(g.ran.some((c) => c.includes("setsid nohup"))).toBe(true);
  });

  it("a legacy preview without a setup restarts without reinstalling", async () => {
    const g = new GitSandbox();
    const id = branchPreview("a".repeat(40), false);
    g.remote = sha("9");
    g.changed = "app/package.json";
    const r = await followPreview(getPreview(db(), id)!, { provider: g, network: networkFor(g), ...fast });
    expect(r.action).toBe("deployed");
    expect(g.ran.some((c) => c.includes("set -o pipefail"))).toBe(false);
    expect(g.ran.some((c) => c.includes("setsid nohup"))).toBe(true);
  });

  it("hard-resets a force-pushed branch", async () => {
    const g = new GitSandbox();
    const id = branchPreview();
    g.remote = sha("d");
    g.fastForward = false;
    const r = await followPreview(getPreview(db(), id)!, { provider: g, network: networkFor(g), ...fast });
    expect(r.action).toBe("reloaded");
    expect(g.ran.some((c) => c.startsWith("git reset --hard"))).toBe(true);
    expect(listPreviewEvents(db(), id)[0]).toMatchObject({ result: "reset" });
  });

  it("a failed install parks the preview at that sha, once", async () => {
    const g = new GitSandbox();
    const id = branchPreview();
    g.remote = sha("e");
    g.changed = "package.json";
    g.installOk = false;
    const deps = { provider: g, network: networkFor(g), ...fast };
    const r = await followPreview(getPreview(db(), id)!, deps);
    expect(r.action).toBe("failed");
    expect(getPreview(db(), id)).toMatchObject({ status: "failed", failedSha: sha("e"), headSha: sha("a") });
    expect(getPreview(db(), id)?.error).toContain("ERR_PNPM_FETCH_404");
    // the same sha is not retried on its own
    const again = await followPreview(getPreview(db(), id)!, deps);
    expect(again).toMatchObject({ action: "unchanged", detail: "known failure" });
  });

  it("a crash after a source change is a failure; a later good push clears it", async () => {
    const g = new GitSandbox();
    const id = branchPreview();
    const deps = { provider: g, network: networkFor(g), ...fast };
    g.remote = sha("f");
    // The dev server died on the new code and will not boot it either:
    // the follower restarts a dead server once, then gives up.
    g.alive = false;
    g.boots = false;
    const broke = await followPreview(getPreview(db(), id)!, deps);
    expect(broke.action).toBe("failed");
    expect(getPreview(db(), id)?.error).toContain("did not come up");
    g.remote = sha("1");
    g.boots = true;
    const fixed = await followPreview(getPreview(db(), id)!, deps);
    expect(fixed.action).toBe("deployed");
    expect(getPreview(db(), id)).toMatchObject({ status: "healthy", headSha: sha("1"), failedSha: null });
  });

  it("a fetch failure changes nothing and pages nobody", async () => {
    const g = new GitSandbox();
    const id = branchPreview();
    g.fetchOk = false;
    const r = await followPreview(getPreview(db(), id)!, { provider: g, network: networkFor(g), ...fast });
    expect(r.action).toBe("skipped");
    expect(getPreview(db(), id)?.status).toBe("healthy");
  });

  it("skips stopped and provisioning previews and stopped sandboxes", async () => {
    const g = new GitSandbox();
    const id = branchPreview();
    g.remote = sha("2");
    updatePreview(db(), id, { status: "stopped" });
    expect((await followPreview(getPreview(db(), id)!, { provider: g, network: networkFor(g) })).action).toBe("skipped");
    expect(g.ran).toHaveLength(0);
    // 0017: a provisioning preview is driven by its create request
    updatePreview(db(), id, { status: "provisioning" });
    expect((await followPreview(getPreview(db(), id)!, { provider: g, network: networkFor(g) })).action).toBe("skipped");
    expect(g.ran).toHaveLength(0);
  });
});

describe("0016 failures in the Inbox", () => {
  it("a failed branch preview needs you until retried or dismissed", async () => {
    const g = new GitSandbox();
    const deps = { provider: g, network: networkFor(g), ...fast };
    const id = branchPreview();
    g.remote = sha("3");
    g.changed = "package.json";
    g.installOk = false;
    await followPreview(getPreview(db(), id)!, deps);

    const before = loadAttention(db()).signature;
    const item = loadInbox(db()).needsYou.find((x) => x.kind === "preview" && x.previewId === id);
    expect(item).toMatchObject({ kind: "preview", sha: sha("3"), branch: "feat/x", projectName: "Follow" });

    dismissPreviewFailure(id);
    expect(loadInbox(db()).needsYou.some((x) => x.kind === "preview" && x.previewId === id)).toBe(false);
    expect(loadAttention(db()).signature).not.toBe(before);

    // a NEW failing sha shows again
    g.remote = sha("4");
    await followPreview(getPreview(db(), id)!, deps);
    expect(loadInbox(db()).needsYou.some((x) => x.kind === "preview" && x.previewId === id)).toBe(true);

    // retry with the cause fixed redeploys the remote head and clears it
    g.installOk = true;
    const r = await retryPreview(id, deps);
    expect(r.action).toBe("deployed");
    expect(getPreview(db(), id)).toMatchObject({ status: "healthy", headSha: sha("4") });
    expect(loadInbox(db()).needsYou.some((x) => x.kind === "preview" && x.previewId === id)).toBe(false);
  });
});

describe("0016 follower helpers", () => {
  it("detects dependency changes by file name, at any depth", () => {
    expect(dependenciesChanged("src/a.ts\nREADME.md")).toBe(false);
    expect(dependenciesChanged("apps/web/package.json")).toBe(true);
    expect(dependenciesChanged("pnpm-lock.yaml")).toBe(true);
    expect(dependenciesChanged("docs/package.json.md")).toBe(false);
  });
});
