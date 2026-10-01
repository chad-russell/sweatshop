import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SandboxShell } from "@/lib/sandbox-shell";

const exec = promisify(execFile);

/**
 * 0006 bridge seam: bridge-backed harnesses (claude, later cursor) run
 * their bridge process inside the session sandbox and connect the eve
 * runtime to it over the private `sweatshop-harness` podman network.
 * Host processes have no route to podman's internal bridge subnets
 * (verified on bee), so membership — never a published port — is the
 * boundary. `./dev` creates the network and puts the dev container on
 * it; this module connects a conversation's sandbox and resolves its
 * endpoint there.
 */

export const HARNESS_NETWORK = "sweatshop-harness";

/** Bridge port inside each sandbox (isolated netns — no collisions). */
export const HARNESS_BRIDGE_PORT = 4000;

const EXEC_OPTS = {
  timeout: 30_000,
  maxBuffer: 4 * 1024 * 1024,
} as const;

async function docker(args: string[]): Promise<{ stdout: string }> {
  const { stdout } = await exec("docker", args, EXEC_OPTS);
  return { stdout };
}

export async function ensureHarnessNetwork(): Promise<void> {
  await exec("docker", ["network", "inspect", HARNESS_NETWORK], EXEC_OPTS).catch(
    async (err: { stderr?: string }) => {
      if (/network .* not found/i.test(err.stderr ?? "")) {
        await docker(["network", "create", HARNESS_NETWORK]);
        return;
      }
      throw err;
    },
  );
}

/**
 * Fail with an actionable error when the eve runtime container itself is
 * not on the harness network (takes effect on the next `./dev` start).
 */
export async function assertRuntimeOnHarnessNetwork(): Promise<void> {
  const hostname = process.env.HOSTNAME;
  if (!hostname) {
    throw new Error(
      "cannot determine this container's id (HOSTNAME) — is this the dev runtime?",
    );
  }
  const { stdout } = await exec(
    "docker",
    [
      "inspect",
      "-f",
      `{{(index .NetworkSettings.Networks "${HARNESS_NETWORK}").IPAddress}}`,
      hostname,
    ],
    EXEC_OPTS,
  );
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(stdout.trim())) {
    throw new Error(
      `this runtime container is not on the ${HARNESS_NETWORK} network — ` +
        `restart ./dev (it joins the network at startup)`,
    );
  }
}

/**
 * Connect this conversation's eve session sandbox to the harness
 * network and return its endpoint there. The sandbox container is
 * identified by a session marker file: eve's container names are
 * provider-internal hashes, so we scan the (few) `eve.sandbox` labeled
 * containers for ours — public surfaces only, no internal coupling.
 */
export async function connectSandboxToHarnessNetwork(args: {
  sessionId: string;
  sandbox: SandboxShell;
}): Promise<{ ip: string; port: number; wsUrl: string }> {
  const { sessionId, sandbox } = args;
  const marker = `/tmp/.sweatshop-sbx-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const write = await sandbox.run(
    `printf %s ${JSON.stringify(sessionId)} > ${JSON.stringify(marker)}`,
  );
  if (write.exitCode !== 0) {
    throw new Error(`could not write sandbox marker: ${write.stderr}`);
  }

  const { stdout: psOut } = await docker([
    "ps",
    "-q",
    "--filter",
    "label=eve.sandbox=1",
  ]);
  const candidates = psOut.split("\n").map((l) => l.trim()).filter(Boolean);
  let containerId: string | undefined;
  for (const candidate of candidates) {
    const cat = await docker(["exec", candidate, "cat", marker]).catch(
      () => ({ stdout: "" }),
    );
    if (cat.stdout.trim() === sessionId) {
      containerId = candidate;
      break;
    }
  }
  if (!containerId) {
    throw new Error(
      "could not identify this conversation's sandbox container " +
        `(scanned ${candidates.length} eve sandbox container(s))`,
    );
  }

  return connectContainerToHarnessNetwork(containerId);
}

/**
 * Join a known container (by id or name) to the harness network and
 * return its bridge endpoint there. Directly provisioned sandboxes
 * (workflow-owned, Path B) know their container name; eve session
 * sandboxes are found by marker first (above).
 */
export async function connectContainerToHarnessNetwork(
  containerId: string,
): Promise<{ ip: string; port: number; wsUrl: string }> {
  await ensureHarnessNetwork();
  await assertRuntimeOnHarnessNetwork();
  await docker(["network", "connect", HARNESS_NETWORK, containerId]).catch(
    (err: { stderr?: string }) => {
      // docker-compatible daemons say "already exists in network";
      // podman says "network is already connected". Both mean joined.
      if (
        !/already exists in network|network is already connected/i.test(
          err.stderr ?? "",
        )
      ) {
        throw err;
      }
    },
  );

  const { stdout: ipOut } = await docker([
    "inspect",
    "-f",
    // Map key contains a dash — Go templates need index, not field access.
    `{{(index .NetworkSettings.Networks "${HARNESS_NETWORK}").IPAddress}}`,
    containerId,
  ]);
  const ip = ipOut.trim();
  if (!ip) {
    throw new Error(
      `sandbox container ${containerId} has no address on ${HARNESS_NETWORK}`,
    );
  }
  return {
    ip,
    port: HARNESS_BRIDGE_PORT,
    wsUrl: `ws://${ip}:${HARNESS_BRIDGE_PORT}`,
  };
}
