import { execFile, spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import type { Experimental_SandboxSession } from "ai";

const exec = promisify(execFile);

/**
 * 0031: the podman substrate the SandboxProvider composes (0010 Phase
 * 2) — container lifecycle primitives plus exec/spawn against a
 * container name. ONE provisioning path: lib/sandboxes/provider.ts is
 * the only creator (the old 0004 Path B direct API is gone).
 */

/** The image a sandbox runs when its project's config names none
 * (built from Containerfile.sandbox). SWEATSHOP_SANDBOX_IMAGE
 * overrides the default ref (e.g. a differently-tagged build) — read
 * at module load, not per call. */
export const DEFAULT_SANDBOX_IMAGE = process.env.SWEATSHOP_SANDBOX_IMAGE || "localhost/sweatshop-sandbox";

/** Container lifecycle primitives (0010 Phase 2): the podman provider
 * composes these; `ref` is the container name. 0013: `image` is the
 * project's `image_ref` (default above). */
export async function createContainer(name: string, image: string = DEFAULT_SANDBOX_IMAGE): Promise<void> {
  await exec("docker", ["run", "-d", "--name", name, image]);
}

/** Stop a container, preserving its state (idle reaping). */
export async function stopContainer(name: string): Promise<void> {
  await exec("docker", ["stop", name]).catch(() => undefined);
}

/** Start a previously stopped container back up. */
export async function startContainer(name: string): Promise<void> {
  await exec("docker", ["start", name]);
}

/** Force-remove a container (destroy); a missing container is fine. */
export async function removeContainer(name: string): Promise<void> {
  await exec("docker", ["rm", "-f", name]).catch(() => undefined);
}

export function sandboxWorkRoot(ownerId: string): string {
  return `/work/${ownerId}`;
}

/**
 * 0082: run every sandboxed command with `pipefail`, so a pipeline's
 * status is its first failing stage, not its last. RCA: an agent ran
 * `npm run test 2>&1 | tail -20` in a dir with no package.json ~200
 * times — npm exited 254, `tail` exited 0, and bash reported 0, so the
 * model never saw a failure. Prepended (not wrapped) so the command's
 * own last status is still bash's exit code.
 */
export function withPipefail(command: string): string {
  return `set -o pipefail\n${command}`;
}

export async function execSandbox(
  containerName: string,
  command: string,
  env?: Record<string, string>,
  workingDirectory?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Env rides as `docker exec -e K=V` flags: a shell `K=V cmd` prefix
  // does NOT work for expansions inside the command itself (POSIX
  // expands before the temporary assignment applies).
  const envArgs = Object.entries(env ?? {}).flatMap(([k, v]) => [
    "-e",
    `${k}=${v}`,
  ]);
  const workdirArgs = workingDirectory ? ["-w", workingDirectory] : [];
  try {
    const { stdout, stderr } = await exec(
      "docker",
      [
        "exec",
        ...workdirArgs,
        ...envArgs,
        containerName,
        "bash",
        "-lc",
        withPipefail(command),
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
    if (typeof e.code === "number" && (e.stdout !== undefined || e.stderr !== undefined)) {
      return { exitCode: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
    return { exitCode: 1, stdout: "", stderr: e.message };
  }
}

/**
 * Streaming `docker exec -i` spawn: real stdout/stderr streams, exit
 * wait and kill — what a bridge process (claude) needs; the run-to-
 * completion replay fallback in the adapter cannot host one.
 */
export function spawnInSandbox(
  containerName: string,
  root?: string,
): Experimental_SandboxSession["spawn"] {
  return async (options) => {
    const args = ["exec", "-i"];
    const cwd = options.workingDirectory ?? root;
    if (cwd) args.push("-w", cwd);
    for (const [k, v] of Object.entries(options.env ?? {})) {
      args.push("-e", `${k}=${v}`);
    }
    args.push(containerName, "bash", "-lc", options.command);
    const child = nodeSpawn("docker", args, { signal: options.abortSignal });
    const exited = new Promise<{ exitCode: number }>((resolve) => {
      child.on("exit", (code) => resolve({ exitCode: code ?? -1 }));
      child.on("error", () => resolve({ exitCode: -1 }));
    });
    return {
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      wait: () => exited,
      kill: async () => {
        child.kill("SIGKILL");
      },
    };
  };
}
