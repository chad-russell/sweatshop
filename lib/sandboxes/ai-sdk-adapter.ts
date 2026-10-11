import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import type { Experimental_SandboxSession } from "ai";
import {
  connectContainerToHarnessNetwork,
  HARNESS_BRIDGE_PORT,
} from "@/lib/sandboxes/harness-bridge";
import type { SandboxShell } from "@/lib/sandbox-shell";

/**
 * The canonical SandboxShell seam plus real long-lived process support
 * (0006) — implemented by a SandboxHandle from the provider (0031: the
 * one handle type), so every consumer sees the identical AI SDK
 * session.
 */
export interface SandboxShellLike extends SandboxShell {
  /**
   * Real long-lived process support (0006): when the backing sandbox
   * exposes one (eve session sandboxes do — streams, env, wait/kill),
   * pass it through for bridge-backed harnesses. Without it the adapter
   * falls back to run-to-completion replay, which cannot host a
   * long-lived bridge process.
   */
  spawn?: Experimental_SandboxSession["spawn"];
}

/**
 * Linux caps ONE exec argument at 128 KiB (MAX_ARG_STRLEN), so a file
 * written as a single `printf '<base64>'` fails with E2BIG past ~96 KB
 * of content (the ACP/cursor bridge bundle is ~126 KB). Write the base64
 * in chunks appended to a temp file, then decode once.
 */
const B64_CHUNK = 64 * 1024;

export async function writeBytes(
  sandbox: SandboxShellLike,
  path: string,
  bytes: Uint8Array,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const b64 = Buffer.from(bytes).toString("base64");
  const quoted = JSON.stringify(path);
  const tmp = `${quoted.slice(0, -1)}.b64.${process.pid}"`;
  const prep = await sandbox.run(`mkdir -p "$(dirname ${quoted})" && : > ${tmp}`);
  if (prep.exitCode !== 0) return { ok: false, error: prep.stderr };
  for (let i = 0; i < b64.length; i += B64_CHUNK) {
    const part = await sandbox.run(`printf %s '${b64.slice(i, i + B64_CHUNK)}' >> ${tmp}`);
    if (part.exitCode !== 0) return { ok: false, error: part.stderr };
  }
  const done = await sandbox.run(`base64 -d ${tmp} > ${quoted}; rc=$?; rm -f ${tmp}; exit $rc`);
  return done.exitCode === 0 ? { ok: true } : { ok: false, error: done.stderr };
}

/**
 * Adapt a shell-capable sandbox (0004/0005) to the AI SDK's structural
 * `Experimental_SandboxSession` contract, so WorkflowAgent's
 * `experimental_sandbox` and sandbox-aware tools work unchanged over
 * our containers. Operations are `docker exec`/stdin writes.
 */
export function toSandboxSession(
  sandbox: SandboxShellLike,
  /** The work root commands default to (/work/<owner>); named in the
   *  description because sandbox-aware tools put it into prompts. */
  workDir?: string,
): Experimental_SandboxSession {
  return {
    description: workDir
      ? `Sandboxed Linux environment with the project's git repositories ` +
        `cloned under ${workDir} (the default working directory). ` +
        `Commands run via bash; use absolute or ${workDir}-relative paths.`
      : `Sandboxed Linux environment. Commands run via bash.`,

    async run(options) {
      // Env rides through execSandbox as docker exec -e flags (a shell
      // `K=V cmd` prefix would not expand inside the command itself);
      // harness bootstrap recipes run commands in a working directory.
      return sandbox.run(
        options.command,
        options.env,
        options.workingDirectory,
      );
    },

    async readTextFile(options) {
      const result = await sandbox.run(`cat ${JSON.stringify(options.path)}`);
      if (result.exitCode !== 0) return null;
      return result.stdout;
    },

    async readBinaryFile(options) {
      const result = await readBinary(sandbox, options.path);
      return result;
    },

    async readFile(options) {
      const bytes = await readBinary(sandbox, options.path);
      if (!bytes) return null;
      return new Blob([bytes as BlobPart]).stream() as ReadableStream<Uint8Array>;
    },

    async writeTextFile(options) {
      const encoding = (options.encoding ?? "utf-8") as BufferEncoding;
      const result = await writeBytes(sandbox, options.path, Buffer.from(options.content, encoding));
      if (!result.ok) throw new Error(`writeTextFile failed: ${result.error}`);
    },

    async writeBinaryFile(options) {
      const result = await writeBytes(sandbox, options.path, options.content);
      if (!result.ok) throw new Error(`writeBinaryFile failed: ${result.error}`);
    },

    async writeFile(options) {
      // Buffer the stream (v1 simplicity), then write once.
      const chunks: Uint8Array[] = [];
      const reader = options.content.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const result = await writeBytes(sandbox, options.path, merged);
      if (!result.ok) {
        throw new Error(`writeFile failed: ${result.error}`);
      }
    },

    async spawn(options) {
      // Real streaming spawn when the backing sandbox provides one
      // (0006: the claude bridge is a long-lived process); otherwise
      // run to completion and replay via synthetic streams.
      if (sandbox.spawn) return sandbox.spawn(options);
      const result = await sandbox.run(options.command, options.env);
      const encoder = new TextEncoder();
      return {
        stdout: replayStream(encoder.encode(result.stdout)),
        stderr: replayStream(encoder.encode(result.stderr)),
        async wait() {
          return { exitCode: result.exitCode };
        },
        async kill() {
          /* process already exited in the replay fallback */
        },
      };
    },
  } satisfies Experimental_SandboxSession;
}

/**
 * 0013 Phase 1: the FULL harness network sandbox session — the basic
 * session above plus identity, the default working directory, and port
 * resolution. Bridge-backed harnesses (claude) resolve their bridge via
 * `getPortEndpoint` instead of a hand-wired `portEndpoint`; the 0006
 * boundary (membership of the private harness network, never a
 * published port) sits behind the resolver.
 *
 * Lifecycle belongs to the lease layer and the sandbox's owner, never a
 * harness: `stop`/`destroy` are no-ops (HarnessAgent only calls them on
 * sandboxes it created itself, which ours never are).
 */
export interface NetworkSandboxSessionArgs {
  /** The lease's `sandboxes.id`. */
  id: string;
  /** The shell the session runs through; `ref` names the container. */
  handle: SandboxShellLike & { readonly ref: string };
  /** Absolute work root; the harness default working directory. */
  workDir: string;
  /** Resolve a container's address on the harness network. Defaults to
   *  joining the sweatshop-harness network (injectable for tests). */
  resolveAddress?: (ref: string) => Promise<string>;
}

export function toNetworkSandboxSession({
  id,
  handle,
  workDir,
  resolveAddress = defaultResolveAddress,
}: NetworkSandboxSessionArgs): HarnessV1NetworkSandboxSession {
  const basic = toSandboxSession(handle, workDir);
  // One network join + inspect per session, lazily — pi never asks.
  // A failed resolve is not cached, so a retry can succeed.
  let address: Promise<string> | undefined;
  const getAddress = () => {
    address ??= resolveAddress(handle.ref).catch((err: unknown) => {
      address = undefined;
      throw err;
    });
    return address;
  };
  const getPortEndpoint = async ({
    port,
    protocol = "http",
  }: {
    port: number;
    protocol?: "http" | "https" | "ws";
  }) => ({ url: `${protocol}://${await getAddress()}:${port}` });

  return {
    ...basic,
    id,
    defaultWorkingDirectory: workDir,
    ports: [HARNESS_BRIDGE_PORT],
    getPortEndpoint,
    getPortUrl: async (options) => (await getPortEndpoint(options)).url,
    stop: async () => {},
    destroy: async () => {},
    restricted: () => basic,
  };
}

async function defaultResolveAddress(ref: string): Promise<string> {
  return (await connectContainerToHarnessNetwork(ref)).ip;
}

function replayStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes as BlobPart]).stream() as ReadableStream<Uint8Array>;
}

async function readBinary(
  sandbox: SandboxShellLike,
  path: string,
): Promise<Uint8Array | null> {
  // Binary-safe read via base64 through the shell.
  const result = await sandbox.run(
    `base64 -w0 ${JSON.stringify(path)}`,
  );
  if (result.exitCode !== 0) return null;
  return Buffer.from(result.stdout.trim(), "base64");
}
