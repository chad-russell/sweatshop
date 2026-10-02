import type { Experimental_SandboxSession } from "ai";
import {
  attachSandbox,
  createContainer,
  removeContainer,
  sandboxWorkRoot,
  startContainer,
  stopContainer,
  type ProvisionedSandbox,
} from "@/lib/sandboxes/provision";
import { setupProjectWorkspace } from "@/lib/sandboxes/setup";

/**
 * 0010 Phase 2 — the SandboxProvider seam. Everything above this layer
 * (tools, harnesses, machines, the UI) asks for sandboxes through
 * acquireSandbox (lib/sandboxes/lease.ts) and never learns what a
 * sandbox is made of: podman containers today, VMs later. "Sandbox", not
 * "container", is the vocabulary on purpose (docs/0010).
 */

export interface SandboxSpec {
  /** Project whose repos are cloned into the sandbox; null = bare. */
  projectId: string | null;
  /** Clone/work root inside the sandbox (default /work/<ownerId>). */
  root?: string;
  /** Deterministic provider name prefix (owner id is used). */
  namePrefix: string;
  /** 0013: the image to run — the project's sandbox config `image_ref`;
   *  unset = the provider default (`localhost/sweatshop-sandbox`). */
  image?: string;
}

export interface SandboxHandle {
  /** Provider-opaque reference (container name today). */
  readonly ref: string;
  run(
    command: string,
    env?: Record<string, string>,
    workingDirectory?: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Real long-lived process (bridge harnesses need one; 0006). */
  spawn: Experimental_SandboxSession["spawn"];
}

export interface SandboxProvider {
  readonly kind: string;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  attach(ref: string, root?: string): SandboxHandle;
  /** Stop, preserving state (idle reaping). */
  stop(ref: string): Promise<void>;
  resume(ref: string): Promise<void>;
  destroy(ref: string): Promise<void>;
}

function suffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * The podman provider (the only one today): a sibling container on host
 * podman — the project config's image, else `localhost/sweatshop-sandbox` — with
 * the project's repos cloned under the work root. `stop` is a plain
 * container stop — filesystem state survives (unlike eve's selector,
 * which replaced stopped session containers with fresh ones).
 */
export const podmanProvider: SandboxProvider = {
  kind: "podman",

  async create(spec) {
    const ref = `sweatshop-sbx-${spec.namePrefix}-${suffix()}`;
    await createContainer(ref, spec.image);

    const root = spec.root ?? sandboxWorkRoot(spec.namePrefix);
    const handle = this.attach(ref, root);
    try {
      // The root must exist before any command can use it as a cwd —
      // including this mkdir, which therefore runs from "/" (the handle's
      // default cwd IS the root, and crun refuses to chdir into a
      // directory that does not exist yet).
      const made = await handle.run(`mkdir -p ${JSON.stringify(root)}`, undefined, "/");
      if (made.exitCode !== 0) {
        throw new Error(`could not create ${root}: ${made.stderr}`);
      }
      if (spec.projectId) {
        await setupProjectWorkspace(handle, spec.projectId, root);
      }
      return handle;
    } catch (err) {
      await removeContainer(ref);
      throw err;
    }
  },

  attach(ref: string, root?: string): SandboxHandle {
    const attached: ProvisionedSandbox = attachSandbox(ref, root);
    return {
      ref: attached.containerName,
      run: (command, env, workingDirectory) =>
        attached.run(command, env, workingDirectory),
      spawn: attached.spawn,
    };
  },

  async stop(ref) {
    await stopContainer(ref);
  },

  async resume(ref) {
    await startContainer(ref);
  },

  async destroy(ref) {
    await removeContainer(ref);
  },
};

/** The active provider; a VM provider lands here later (docs/0010). */
export function sandboxProvider(): SandboxProvider {
  return podmanProvider;
}
