import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  openConversationSandbox,
  openInheritedSandbox,
  type BoundSandbox,
} from "@/lib/sandboxes/binding";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * 0035: the screenshot attach core. A PNG that already exists in the
 * sandbox (agent-browser wrote it, or anything else did) is copied out
 * to data/attachments and served by /api/attachments/<id> — so QA
 * evidence shows in the conversation instead of dying with the
 * container. Plain function on purpose: the workflow steps are thin
 * wrappers, and tests inject the provider + directory here.
 */

export type ScreenshotResult =
  | ({ ok: true; id: string; url: string; bytes: number; width: number; height: number; note: string })
  | { ok: false; code: string; message: string };

export interface ScreenshotInput {
  /** Path inside the sandbox (absolute, or relative to the workDir). */
  path: string;
  /** One line of context, shown under the image. */
  label?: string;
}

export interface ScreenshotDeps {
  provider?: SandboxProvider;
  /** Where attachments land; default data/attachments under cwd. */
  dir?: string;
}

/** The one attachment root: data/attachments (ATTACHMENTS_DIR overrides). */
export function attachmentsDir(): string {
  return process.env.ATTACHMENTS_DIR ?? path.join(process.cwd(), "data", "attachments");
}

const MAX_BYTES = 10 * 1024 * 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Caller =
  | { kind: "conversation"; conversationId: string }
  | { kind: "inherited"; sessionId: string; binding: BoundSandbox };

type Fail = { ok: false; code: string; message: string };

function fail(code: string, message: string): Fail {
  return { ok: false, code, message };
}

async function readPng(
  run: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  inputPath: string,
): Promise<{ ok: true; data: Buffer } | Fail> {
  // The path lives inside the sandbox container; quote it for the shell.
  const quoted = `'${inputPath.replace(/'/g, `'\\''`)}'`;
  const stat = await run(`stat -c %s ${quoted} 2>/dev/null || echo -1`);
  const size = Number(stat.stdout.trim().split("\n").pop());
  if (!Number.isFinite(size) || size < 0) return fail("not-found", `no file at ${inputPath}`);
  if (size === 0) return fail("empty", `${inputPath} is empty`);
  if (size > MAX_BYTES) return fail("too-large", `${inputPath} is ${(size / 1024 / 1024).toFixed(1)} MiB; the cap is 10`);
  const b64 = await run(`base64 -w0 ${quoted}`);
  if (b64.exitCode !== 0) return fail("read-failed", `could not read ${inputPath}`);
  const data = Buffer.from(b64.stdout.trim(), "base64");
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIG)) {
    return fail("not-png", `${inputPath} is not a PNG (attach converts nothing — save the screenshot as PNG)`);
  }
  return { ok: true, data };
}

async function attach(caller: Caller, input: ScreenshotInput, deps: ScreenshotDeps): Promise<ScreenshotResult> {
  try {
    if (!input.path || typeof input.path !== "string") return fail("invalid", "path is required");
    const opened =
      caller.kind === "conversation"
        ? await openConversationSandbox(caller.conversationId, deps.provider)
        : await openInheritedSandbox(caller.binding, deps.provider);
    const abs = input.path.startsWith("/") ? input.path : `${opened.workDir.replace(/\/+$/, "")}/${input.path.replace(/^\.\/?/, "")}`;
    const read = await readPng((command) => opened.handle.run(command, undefined, opened.workDir), abs);
    if (!read.ok) return read;
    const id = `att_${randomBytes(9).toString("hex")}`;
    const dir = deps.dir ?? attachmentsDir();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${id}.png`), read.data);
    const width = read.data.readUInt32BE(16);
    const height = read.data.readUInt32BE(20);
    return {
      ok: true,
      id,
      url: `/api/attachments/${id}`,
      bytes: read.data.length,
      width,
      height,
      note: `attached — ${width}x${height}, shown in the conversation; also open at ${input.label ? `${input.label} · ` : ""}${id}`,
    };
  } catch (err) {
    return fail("failed", err instanceof Error ? err.message : String(err));
  }
}

export async function attachScreenshotTool(
  conversationId: string,
  input: ScreenshotInput,
  deps: ScreenshotDeps = {},
): Promise<ScreenshotResult> {
  return attach({ kind: "conversation", conversationId }, input, deps);
}

/** 0013: attach from an inherited binding (agent/harness stage, run sandbox). */
export async function attachScreenshotIn(
  sessionId: string,
  binding: BoundSandbox,
  input: ScreenshotInput,
  deps: ScreenshotDeps = {},
): Promise<ScreenshotResult> {
  void sessionId; // attribution rides the tool-call result, not the file
  return attach({ kind: "inherited", sessionId, binding }, input, deps);
}
