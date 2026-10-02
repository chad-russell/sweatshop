import type { Experimental_SandboxSession } from "ai";
import type { SandboxShell } from "@/lib/sandbox-shell";

/**
 * The canonical SandboxShell seam plus real long-lived process support
 * (0006) — implemented by ProvisionedSandbox (Path B) and by a thin
 * wrapper over an eve session sandbox (Path A), so both paths present
 * identical AI SDK sessions.
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
      const b64 = Buffer.from(options.content, encoding).toString("base64");
      const result = await sandbox.run(
        `mkdir -p $(dirname ${JSON.stringify(options.path)}) && ` +
          `printf %s '${b64}' | base64 -d > ${JSON.stringify(options.path)}`,
      );
      if (result.exitCode !== 0) {
        throw new Error(`writeTextFile failed: ${result.stderr}`);
      }
    },

    async writeBinaryFile(options) {
      // Base64 transport through the shell: quoting-safe for any bytes.
      const b64 = Buffer.from(options.content).toString("base64");
      const result = await sandbox.run(
        `mkdir -p $(dirname ${JSON.stringify(options.path)}) && ` +
          `printf %s '${b64}' | base64 -d > ${JSON.stringify(options.path)}`,
      );
      if (result.exitCode !== 0) {
        throw new Error(`writeBinaryFile failed: ${result.stderr}`);
      }
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
      const b64 = Buffer.from(merged).toString("base64");
      const result = await sandbox.run(
        `mkdir -p $(dirname ${JSON.stringify(options.path)}) && ` +
          `printf %s '${b64}' | base64 -d > ${JSON.stringify(options.path)}`,
      );
      if (result.exitCode !== 0) {
        throw new Error(`writeFile failed: ${result.stderr}`);
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
