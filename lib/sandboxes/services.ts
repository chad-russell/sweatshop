import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "@/db";
import {
  getService,
  insertService,
  listSandboxServices,
  markSandboxServicesDestroyed,
  updateService,
} from "@/db/sandbox-services";
import { getLease, touchLease } from "@/db/sandboxes";
import { HARNESS_NETWORK } from "@/lib/sandboxes/harness-bridge";
import type { SandboxHandle } from "@/lib/sandboxes/provider";
import type { ServiceSpec } from "@/lib/sandboxes/service-spec";

/**
 * 0017 phase 3: declared services — the substrate backend for the
 * setup's `services`. THE DECLARATION IS THE DESIGN, THE SUBSTRATE IS
 * A SEAM: everything here satisfies the contract (the image is
 * running; the sandbox can dial `<ref>:<port>`; it dies with the
 * sandbox) and nothing above this module knows how. The v1 backend is
 * sibling containers on `sweatshop-harness` through the podman socket;
 * a future VM provider runs the same declarations in-VM.
 */

export type { ServiceSpec };

/** One docker invocation, returning stdout — injectable so unit tests
 *  script the substrate. */
export type DockerRunner = (args: string[]) => Promise<string>;

const exec = promisify(execFile);

export const realDockerRunner: DockerRunner = async (args) => {
  const { stdout } = await exec("docker", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

export interface ServiceDeps {
  /** Defaults to the real podman socket. */
  docker?: DockerRunner;
}

export class ServiceError extends Error {}

/** The sibling container's name — unique per (sandbox, service), a DNS
 *  label (≤63): `<sandbox-ref>-svc-<name>`, hashed down if too long. */
export function serviceContainerName(sandboxRef: string, name: string): string {
  const full = `${sandboxRef}-svc-${name}`;
  if (full.length <= 63) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 6);
  const keep = 63 - `-svc-${name}-${hash}`.length;
  return `${sandboxRef.slice(0, keep)}-svc-${name}-${hash}`;
}

async function isRunning(docker: DockerRunner, ref: string): Promise<boolean> {
  try {
    return (await docker(["inspect", "-f", "{{.State.Running}}", ref])).trim() === "true";
  } catch {
    return false; // no such container (or inspect failed) — recreate
  }
}

/** Split a command string into argv the way a shell would (quote- and
 *  escape-aware, no expansion) — compose-style `command:` semantics:
 *  the pieces are ARGS to the image's entrypoint, not a shell line. */
export function splitArgs(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += command[++i]!;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || current) out.push(current);
      current = "";
      has = false;
      continue;
    }
    current += ch;
    has = true;
  }
  if (has || current) out.push(current);
  return out;
}

async function runService(docker: DockerRunner, ref: string, spec: ServiceSpec): Promise<void> {
  // A leftover container with our name (a crash between rm and run)
  // would collide — clear it first; a missing one is fine.
  await docker(["rm", "-f", ref]).catch(() => undefined);
  const envArgs = Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  // `command` is argv for the image's ENTRYPOINT (compose semantics) —
  // arbitrary images may have none of our shell assumptions.
  const commandArgs = spec.command ? splitArgs(spec.command) : [];
  await docker([
    "run",
    "-d",
    "--name",
    ref,
    "--network",
    HARNESS_NETWORK,
    ...envArgs,
    spec.image,
    ...commandArgs,
  ]);
}

/**
 * Idempotent per (sandbox, service): create-if-missing,
 * start-if-stopped, recreate-if-gone. Throws ServiceError when the
 * substrate refuses (image pull failure, name conflict) — the caller
 * parks the preview failed with the reason.
 */
export async function ensureSandboxServices(
  sandboxId: string,
  specs: ServiceSpec[],
  deps: ServiceDeps = {},
): Promise<void> {
  const docker = deps.docker ?? realDockerRunner;
  const lease = getLease(db(), sandboxId);
  if (!lease || lease.status === "destroyed") {
    throw new ServiceError(`sandbox ${sandboxId} is ${lease?.status ?? "missing"}`);
  }
  for (const spec of specs) {
    let row = getService(db(), sandboxId, spec.name);
    if (!row) {
      row = insertService(db(), {
        sandboxId,
        name: spec.name,
        image: spec.image,
        ref: serviceContainerName(lease.ref, spec.name),
        port: spec.port,
      });
    }
    if (row.status === "destroyed") {
      // The sandbox outlived a destroyed row (should not happen); recreate.
      const ref = serviceContainerName(lease.ref, spec.name);
      updateService(db(), row.id, { ref, status: "creating" });
      row = { ...row, ref, status: "creating" as const };
    }
    // Actual liveness, not "did start succeed" — a crash-looped
    // container starts fine and dies; recreate it with current args.
    if (!(await isRunning(docker, row.ref))) {
      try {
        await runService(docker, row.ref, spec);
      } catch (err) {
        updateService(db(), row.id, { status: "stopped" });
        throw new ServiceError(
          `service ${spec.name} (${spec.image}) failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      updateService(db(), row.id, { status: "running" });
    }
  }
  touchLease(db(), sandboxId);
}

/** The address `${service:<name>:<port>}` resolves to on this substrate:
 *  the sibling's container name, resolvable by the sandbox (and the
 *  proxy) on the harness network. Value-shaped when not running. */
export function serviceAddress(
  sandboxId: string,
  name: string,
): { address: string } | { error: string } {
  const row = getService(db(), sandboxId, name);
  if (!row) return { error: `no service ${name} is declared for this sandbox` };
  if (row.status !== "running") return { error: `service ${name} is ${row.status}` };
  return { address: row.ref };
}

/**
 * Readiness FROM INSIDE the sandbox (portable, and it tests exactly
 * what the app will experience — the Next process may not be able to
 * dial the service at all on a remote substrate). A bash /dev/tcp
 * connect against the provider-resolved address.
 */
export async function probeServiceReady(
  handle: SandboxHandle,
  address: string,
  port: number,
  budgetMs = 10_000,
  pollMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const result = await handle.run(
      `timeout 2 bash -c '</dev/tcp/${address}/${port}' >/dev/null 2>&1 && echo ready`,
      undefined,
      "/",
    );
    if (result.stdout.trim() === "ready") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Destroy the sandbox's service containers and close their rows. */
export async function destroySandboxServices(sandboxId: string, deps: ServiceDeps = {}): Promise<void> {
  const docker = deps.docker ?? realDockerRunner;
  for (const row of listSandboxServices(db(), sandboxId)) {
    if (row.status !== "destroyed" && row.ref) {
      await docker(["rm", "-f", row.ref]).catch(() => undefined);
    }
  }
  markSandboxServicesDestroyed(db(), sandboxId);
}
