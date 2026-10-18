import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 0033 Phase A: the gh core — allowlist discipline, argv safety (no
 * shell), credential handling (token never in output, not-configured
 * without one), clipping. execFile is mocked; nothing touches the
 * network or a real gh.
 */

const execFile = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    opts: { env: Record<string, string> },
    callback: (err: unknown, stdout: string, stderr: string) => void,
  ) => {
    execFile({ cmd, args, opts, callback });
  },
}));

import { db } from "../db";
import { gitCredentials } from "../db/schema";
import { runGh } from "../lib/agent/tools/gh";

const TOKEN = "ghp_testtoken123";

const seedCredential = () =>
  db()
    .insert(gitCredentials)
    .values({
      id: "gh-test", kind: "github", label: "test", username: "chad",
      secret: TOKEN, baseUrl: null, createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();

beforeEach(() => {
  execFile.mockReset();
  db().delete(gitCredentials).run();
});

describe("gh allowlist", () => {
  it("rejects non-allowlisted command paths with the listing", async () => {
    for (const bad of [["repo", "delete", "x"], ["api", "/user"], ["auth", "login"], ["repo"], [""]]) {
      const result = await runGh(bad as string[]);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) {
        expect(["bad-args", "not-allowed"]).toContain(result.code);
        expect(result.allowed).toContain("repo view");
      }
    }
  });

  it("passes allowlisted commands through as an argv array with the token in env", async () => {
    seedCredential();
    execFile.mockImplementationOnce(({ callback }) => callback(null, "ok", ""));
    const result = await runGh(["repo", "view", "TangoGroup/360-gpl", "--json", "name"]);
    expect(result.ok).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
    const call = execFile.mock.calls[0]![0] as { cmd: string; args: string[]; opts: { env: Record<string, string> } };
    expect(call.cmd).toBe("gh");
    expect(call.args).toEqual(["repo", "view", "TangoGroup/360-gpl", "--json", "name"]);
    expect(call.opts.env.GH_TOKEN).toBe(TOKEN);
  });

  it("is not-configured without a github credential (no exec attempted)", async () => {
    const result = await runGh(["repo", "list"]);
    expect(result).toMatchObject({ ok: false, code: "not-configured" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("scrubs the token from successful output and from errors", async () => {
    seedCredential();
    execFile.mockImplementationOnce(({ callback }) => callback(null, `token is ${TOKEN}`, ""));
    const ok = await runGh(["org", "list"]);
    expect(ok.ok ? ok.output : "").not.toContain(TOKEN);
    execFile.mockImplementationOnce(({ callback }) => callback({ code: 1, message: `boom ${TOKEN}` }, "", ""));
    const failed = await runGh(["pr", "list"]);
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
  });

  it("reports gh-not-installed (ENOENT) and command failures as values", async () => {
    seedCredential();
    execFile.mockImplementationOnce(({ callback }) => callback({ code: "ENOENT" }, "", ""));
    expect(await runGh(["org", "list"])).toMatchObject({ ok: false, code: "gh-not-installed" });
    execFile.mockImplementationOnce(({ callback }) => callback({ code: 1, message: "x" }, "", "nope"));
    expect(await runGh(["pr", "list"])).toMatchObject({ ok: false, code: "gh-failed" });
  });

  it("clips long output", async () => {
    seedCredential();
    execFile.mockImplementationOnce(({ callback }) => callback(null, "x".repeat(30_000), ""));
    const result = await runGh(["repo", "list"]);
    expect(result.ok ? result.output.length : 0).toBeLessThan(30_000);
    expect(result.ok ? result.output : "").toContain("chars clipped");
  });
});
