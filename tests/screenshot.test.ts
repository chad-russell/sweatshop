import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Experimental_SandboxSession } from "ai";
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
import { bindConversation } from "../db/sandboxes";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";
import { attachScreenshotIn, attachScreenshotTool } from "../lib/agent/tools/screenshot";
import { GET as getAttachment } from "../app/api/attachments/[id]/route";

/**
 * 0035: the screenshot attach path — a sandbox PNG becomes a durable
 * file under data/attachments with a serving URL, rejected unless it is
 * a real PNG under the size cap. The scripted sandbox serves stat/base64
 * for planted files (that is all the core runs inside the container).
 */

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(48);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

class FileSandbox implements SandboxProvider {
  readonly kind = "podman";
  files = new Map<string, Buffer>();
  async create(): Promise<SandboxHandle> {
    throw new Error("unused");
  }
  attach(ref: string): SandboxHandle {
    return {
      ref,
      run: async (command) => {
        const m = /(?:stat -c %s|base64 -w0) '([^']+)'/.exec(command);
        if (!m) return { exitCode: 0, stdout: "", stderr: "" };
        const file = this.files.get(m[1]);
        if (!file) {
          // the core's stat runs with `|| echo -1` — a miss yields -1
          if (command.startsWith("stat")) return { exitCode: 0, stdout: "-1", stderr: "" };
          return { exitCode: 1, stdout: "", stderr: "no file" };
        }
        return {
          exitCode: 0,
          stdout: command.startsWith("stat") ? String(file.length) : file.toString("base64"),
          stderr: "",
        };
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

describe("0035 screenshot attach", () => {
  it("copies a sandbox PNG out with dims and a serving URL", async () => {
    const sbx = new FileSandbox();
    const dir = await mkdtemp(path.join(tmpdir(), "att-"));
    sbx.files.set("/work/c_shot1/qa/after.png", png(1100, 810));
    ensureConversation(db(), "c_shot1", null);
    db().$client
      .prepare(
        "insert into sandboxes (id, provider, ref, owner_kind, owner_id, status, last_used_at, created_at) " +
          "values (?, 'podman', 'ref-shot1', 'conversation', 'c_shot1', 'running', ?, 0)",
      )
      .run("sbx_shot1", Date.now());
    bindConversation(db(), "c_shot1", { kind: "bound", sandboxId: "sbx_shot1", workDir: "/work/c_shot1", owner: true });
    const result = await attachScreenshotTool("c_shot1", { path: "qa/after.png", label: "after" }, { provider: sbx, dir });
    expect(result).toMatchObject({ ok: true, width: 1100, height: 810, url: `/api/attachments/${result.ok ? result.id : ""}` });
    if (!result.ok) throw new Error("unreachable");
    const stored = await readFile(path.join(dir, `${result.id}.png`));
    expect(stored.subarray(0, 8)).toEqual(png(1, 1).subarray(0, 8));
  });

  it("rejects non-PNG and missing files, value-shaped", async () => {
    const sbx = new FileSandbox();
    const dir = await mkdtemp(path.join(tmpdir(), "att-"));
    sbx.files.set("/work/x/shot.jpg", Buffer.from("not a png at all, definitely not"));
    const binding = { kind: "bound" as const, sandboxId: "sbx_shot2", workDir: "/work/x", owner: false };
    db().$client
      .prepare(
        "insert into sandboxes (id, provider, ref, owner_kind, owner_id, status, last_used_at, created_at) " +
          "values (?, 'podman', 'ref-shot2', 'run', 'mr_shot2', 'running', ?, 0)",
      )
      .run("sbx_shot2", Date.now());
    const bad = await attachScreenshotIn("mr_shot2_3", binding, { path: "/work/x/shot.jpg" }, { provider: sbx, dir });
    expect(bad).toMatchObject({ ok: false, code: "not-png" });
    const missing = await attachScreenshotIn("mr_shot2_3", binding, { path: "/work/x/nope.png" }, { provider: sbx, dir });
    expect(missing).toMatchObject({ ok: false, code: "not-found" });
    const files = await readdir(dir);
    expect(files).toEqual([]);
  });

  it("serves an attachment immutably and refuses bad ids", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "att-"));
    process.env.ATTACHMENTS_DIR = dir;
    await writeFile(path.join(dir, "att_deadbeef.png"), png(4, 4));
    const good = await getAttachment(new Request("http://x"), { params: Promise.resolve({ id: "att_deadbeef" }) });
    expect(good.status).toBe(200);
    expect(good.headers.get("content-type")).toBe("image/png");
    expect(good.headers.get("cache-control")).toContain("immutable");
    for (const id of ["../deadbeef", "att_nope", "att_UP", ""]) {
      const res = await getAttachment(new Request("http://x"), { params: Promise.resolve({ id }) });
      expect([400, 404]).toContain(res.status);
    }
    delete process.env.ATTACHMENTS_DIR;
  });
});
