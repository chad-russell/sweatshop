import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { toSandboxSession, writeBytes } from "../lib/sandboxes/ai-sdk-adapter";

const exec = promisify(execFile);

/**
 * 0038: file writes into a sandbox ride one argv per command, and Linux
 * caps a single argument at 128 KiB — the old one-shot `printf '<b64>'`
 * died with E2BIG past ~96 KB (the ACP/cursor bridge bundle is ~126 KB).
 * The fake handle runs each command in real bash with the same cap, so
 * this is a true round trip, not a string assertion.
 */
function bashHandle() {
  const longest = { n: 0 };
  return {
    longest,
    handle: {
      ref: "local",
      async run(command: string) {
        longest.n = Math.max(longest.n, command.length);
        if (command.length > 128 * 1024) {
          return { exitCode: 1, stdout: "", stderr: "spawn E2BIG" };
        }
        try {
          const { stdout, stderr } = await exec("bash", ["-c", command]);
          return { exitCode: 0, stdout, stderr };
        } catch (err) {
          const e = err as { code?: number; stdout?: string; stderr?: string };
          return { exitCode: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
        }
      },
    },
  };
}

describe("writeBytes (0038)", () => {
  it("round-trips content far over the single-argument cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "write-bytes-"));
    try {
      const { handle, longest } = bashHandle();
      const bytes = new Uint8Array(400_000).map((_, i) => (i * 31 + 7) % 256);
      const path = join(dir, "nested", "bridge.bin");
      const result = await writeBytes(handle, path, bytes);
      expect(result).toEqual({ ok: true });
      expect(Buffer.compare(await readFile(path), Buffer.from(bytes))).toBe(0);
      expect(longest.n).toBeLessThan(128 * 1024);
      // The temp file is gone.
      const { stdout } = await exec("ls", [join(dir, "nested")]);
      expect(stdout.trim()).toBe("bridge.bin");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles empty content and paths with spaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "write-bytes-"));
    try {
      const { handle } = bashHandle();
      const path = join(dir, "a dir", "empty file");
      expect(await writeBytes(handle, path, new Uint8Array())).toEqual({ ok: true });
      expect((await readFile(path)).length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a failing write instead of swallowing it", async () => {
    const { handle } = bashHandle();
    const result = await writeBytes(handle, "/proc/nope/x", new Uint8Array([1, 2, 3]));
    expect(result.ok).toBe(false);
  });

  it("serves writeTextFile and writeBinaryFile through it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "write-bytes-"));
    try {
      const { handle } = bashHandle();
      const session = toSandboxSession(handle);
      const big = "x".repeat(300_000);
      await session.writeTextFile({ path: join(dir, "t.txt"), content: big });
      expect((await readFile(join(dir, "t.txt"), "utf8")).length).toBe(300_000);
      await session.writeBinaryFile({ path: join(dir, "b.bin"), content: new Uint8Array([0, 255, 10, 39]) });
      expect([...(await readFile(join(dir, "b.bin")))]).toEqual([0, 255, 10, 39]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
