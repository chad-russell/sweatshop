import { describe, expect, it } from "vitest";
import type { Experimental_SandboxSession } from "ai";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
import { projects } from "../db/schema";
import { runBash } from "../lib/agent/tools/bash";
import { resultFilePath, saveResultFile, RESULT_FILE_CAP } from "../lib/chat/result-file";
import type { SandboxHandle, SandboxProvider, SandboxSpec } from "../lib/sandboxes/provider";

/**
 * 0040 phase 3: `saveResultFile` — bound-only, best-effort, never blocks
 * a wake. Same "fake provider, never provision just to look" discipline
 * as tests/repo-docs-tool.test.ts's loadRepoDocs suite.
 */

class FakeProvider implements SandboxProvider {
  readonly kind = "fake";
  created: SandboxSpec[] = [];
  writes: { path: string; content: string }[] = [];
  private n = 0;
  broken = false;

  create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.created.push(spec);
    this.n += 1;
    return Promise.resolve(this.handle(`fake-${this.n}`));
  }
  attach(ref: string): SandboxHandle {
    return this.handle(ref);
  }
  async stop() {}
  async resume() {}
  async destroy() {}

  private handle(ref: string): SandboxHandle {
    return {
      ref,
      run: (command) => {
        if (this.broken) return Promise.reject(new Error("sandbox unreachable"));
        const match = /mkdir -p (\S+) && printf %s '((?:[^'\\]|\\.)*)' \| base64 -d > (\S+)/.exec(command);
        if (match) {
          const [, , b64, path] = match;
          this.writes.push({ path: path!, content: Buffer.from(b64!, "base64").toString("utf8") });
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
      spawn: (() => {
        throw new Error("spawn not needed here");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
}

let seq = 0;
const chatId = () => `c_resultfile_${++seq}`;

describe("saveResultFile", () => {
  it("a plain chat with no sandbox binding at all saves nothing", async () => {
    const provider = new FakeProvider();
    const id = chatId();
    ensureConversation(db(), id);
    expect(await saveResultFile(id, "hc_x", "the result", provider)).toBeNull();
    expect(provider.created).toHaveLength(0);
  });

  it("a pending project sandbox (never bound) saves nothing — never provisions one to do it", async () => {
    const provider = new FakeProvider();
    db().insert(projects).values({ id: "p_resultfile", name: "ResultFile", createdAt: 0 }).onConflictDoNothing().run();
    const id = chatId();
    ensureConversation(db(), id, "p_resultfile");
    expect(await saveResultFile(id, "hc_x", "the result", provider)).toBeNull();
    expect(provider.created).toHaveLength(0);
  });

  it("writes to the deterministic path under the bound sandbox's workDir, beside repos never inside one", async () => {
    const provider = new FakeProvider();
    db().insert(projects).values({ id: "p_resultfile", name: "ResultFile", createdAt: 0 }).onConflictDoNothing().run();
    const id = chatId();
    ensureConversation(db(), id, "p_resultfile");
    await runBash(id, "pwd", provider); // binds the sandbox, like a real bash call

    const path = await saveResultFile(id, "hc_abc", "line one\nline two", provider);
    expect(path).toBe(`/work/${id}/.sweatshop/results/hc_abc.md`);
    expect(path).toEqual(resultFilePath(`/work/${id}`, "hc_abc"));
    // Not nested under any repo clone directory.
    expect(path).not.toMatch(/\/work\/[^/]+\/[^/]+\/\.sweatshop\//);
    expect(provider.writes).toHaveLength(1);
    expect(provider.writes[0]!.content).toBe("line one\nline two");
  });

  it("caps content at the 60k file cap with a note, instead of writing it unbounded", async () => {
    const provider = new FakeProvider();
    db().insert(projects).values({ id: "p_resultfile", name: "ResultFile", createdAt: 0 }).onConflictDoNothing().run();
    const id = chatId();
    ensureConversation(db(), id, "p_resultfile");
    await runBash(id, "pwd", provider);

    const long = "x".repeat(RESULT_FILE_CAP + 5_000);
    await saveResultFile(id, "hc_long", long, provider);
    const written = provider.writes[0]!.content;
    expect(written.length).toBeLessThan(long.length);
    expect(written).toContain("more chars cut");
  });

  it("a failed write returns null without throwing — the wake must still proceed", async () => {
    const provider = new FakeProvider();
    db().insert(projects).values({ id: "p_resultfile", name: "ResultFile", createdAt: 0 }).onConflictDoNothing().run();
    const id = chatId();
    ensureConversation(db(), id, "p_resultfile");
    await runBash(id, "pwd", provider);
    provider.broken = true;
    await expect(saveResultFile(id, "hc_broken", "content", provider)).resolves.toBeNull();
  });
});
