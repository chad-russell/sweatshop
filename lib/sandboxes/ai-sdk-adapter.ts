import type { Experimental_SandboxSession } from "ai";
import type { ProvisionedSandbox } from "@/lib/sandboxes/provision";

/**
 * Adapt a directly provisioned container (0004 Path B) to the AI SDK's
 * structural `Experimental_SandboxSession` contract, so WorkflowAgent's
 * `experimental_sandbox` and sandbox-aware tools work unchanged over our
 * podman containers. All operations are `docker exec`/stdin writes.
 */
export function toSandboxSession(
  sandbox: ProvisionedSandbox,
): Experimental_SandboxSession {
  return {
    description:
      `Sandboxed Linux container ${sandbox.containerName} with the ` +
      `project's git repositories cloned under /workspace. Commands run ` +
      `from / via sh; use absolute or /workspace-relative paths.`,

    async run(options) {
      // Env rides through execSandbox as docker exec -e flags (a shell
      // `K=V cmd` prefix would not expand inside the command itself).
      return sandbox.run(options.command, options.env);
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
      // v1: no streaming exec — run to completion and replay via
      // synthetic streams. Suitable for non-interactive phase commands.
      const result = await sandbox.run(options.command);
      const encoder = new TextEncoder();
      return {
        stdout: replayStream(encoder.encode(result.stdout)),
        stderr: replayStream(encoder.encode(result.stderr)),
        async wait() {
          return { exitCode: result.exitCode };
        },
        async kill() {
          /* process already exited in v1 */
        },
      };
    },
  } satisfies Experimental_SandboxSession;
}

function replayStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes as BlobPart]).stream() as ReadableStream<Uint8Array>;
}

async function readBinary(
  sandbox: ProvisionedSandbox,
  path: string,
): Promise<Uint8Array | null> {
  // Binary-safe read via base64 through the shell.
  const result = await sandbox.run(
    `base64 -w0 ${JSON.stringify(path)}`,
  );
  if (result.exitCode !== 0) return null;
  return Buffer.from(result.stdout.trim(), "base64");
}
