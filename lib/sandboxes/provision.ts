import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  run(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  remove(): Promise<void>;
}

const SANDBOX_IMAGE = "localhost/sweatshop-sandbox";

function randomName(projectId: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `sweatshop-wf-${projectId}-${suffix}`;
}

/** Re-attach to an existing container by name (stateless wrappers). */
export function attachSandbox(containerName: string): ProvisionedSandbox {
  return {
    containerName,
    plan: undefined,
    run(command: string) {
      return execSandbox(containerName, command);
    },
    async remove() {
      await exec("docker", ["rm", "-f", containerName]).catch(() => undefined);
    },
  };
}

async function execSandbox(
  containerName: string,
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(
      "docker",
      ["exec", containerName, "sh", "-lc", command],
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

export async function provisionProjectSandbox(
  projectId: string,
): Promise<ProvisionedSandbox> {
  const containerName = randomName(projectId);
  await exec("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    SANDBOX_IMAGE,
  ]);

  const run = (command: string) => execSandbox(containerName, command);
  const remove = async () => {
    await exec("docker", ["rm", "-f", containerName]).catch(() => undefined);
  };

  let plan: ProjectPlan | undefined;
  try {
    plan = await setupProjectWorkspace({ run }, projectId);
  } catch (err) {
    await remove();
    throw err;
  }
  return { containerName, plan, run, remove };
}
