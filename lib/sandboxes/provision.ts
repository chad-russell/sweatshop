import { execFile, spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import type { Experimental_SandboxSession } from "ai";
import { setupProjectWorkspace, type ProjectPlan } from "@/lib/sandboxes/setup";

const exec = promisify(execFile);

/**
 * Directly provisioned project sandbox containers (0004 Path B): a
 * `localhost/sweatshop-sandbox` container on host podman (via the docker
 * CLI + socket available inside the runtime container), set up with the
 * same workspace provisioning as eve session sandboxes. Lifecycle is the
 * caller's (the workflow provisions in a step and removes in finally).
 */
export interface ProvisionedSandbox {
  readonly containerName: string;
  readonly plan: ProjectPlan | undefined;
  run(
    command: string,
    env?: Record<string, string>,
    workingDirectory?: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Real long-lived process (0006 bridge harnesses need one). */
  spawn: Experimental_SandboxSession["spawn"];
  remove(): Promise<void>;
}

const SANDBOX_IMAGE = "localhost/sweatshop-sandbox";

function randomName(projectId: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `sweatshop-wf-${projectId}-${suffix}`;
}

/**
 * Re-attach to an existing container by name (stateless wrappers).
 * `root` becomes the default working directory of every command — the
 * directory a harness resolves as its sandbox home via `pwd`.
 */
export function attachSandbox(containerName: string, root?: string): ProvisionedSandbox {
  return {
    containerName,
    plan: undefined,
    run(command: string, env?: Record<string, string>, workingDirectory?: string) {
      return execSandbox(containerName, command, env, workingDirectory ?? root);
    },
    spawn: spawnInSandbox(containerName, root),
    async remove() {
      await exec("docker", ["rm", "-f", containerName]).catch(() => undefined);
    },
  };
}

async function execSandbox(
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
        command,
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

export async function provisionProjectSandbox(
  projectId: string,
  /** Clone root (default /workspace); 0009 machine runs pass a per-run one. */
  root?: string,
): Promise<ProvisionedSandbox> {
  const containerName = randomName(projectId);
  await exec("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    SANDBOX_IMAGE,
  ]);

  const run = (
    command: string,
    env?: Record<string, string>,
    workingDirectory?: string,
  ) => execSandbox(containerName, command, env, workingDirectory ?? root);
  const remove = async () => {
    await exec("docker", ["rm", "-f", containerName]).catch(() => undefined);
  };

  let plan: ProjectPlan | undefined;
  try {
    // The root must exist before any command can use it as a cwd.
    if (root) {
      const made = await execSandbox(containerName, `mkdir -p ${JSON.stringify(root)}`);
      if (made.exitCode !== 0) throw new Error(`could not create ${root}: ${made.stderr}`);
    }
    plan = await setupProjectWorkspace({ run }, projectId, root);
  } catch (err) {
    await remove();
    throw err;
  }
  return { containerName, plan, run, spawn: spawnInSandbox(containerName, root), remove };
}
