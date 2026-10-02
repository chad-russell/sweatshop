import { db } from "@/db";
import {
  deleteLease,
  getLease,
  getLeaseByOwner,
  insertLease,
  markDestroyed,
  touchLease,
  updateLease,
  upsertAttachment,
  type SandboxOwnerKind,
} from "@/db/sandboxes";
import { sandboxWorkRoot } from "@/lib/sandboxes/provision";
import {
  sandboxProvider,
  type SandboxHandle,
  type SandboxProvider,
} from "@/lib/sandboxes/provider";

/**
 * 0010 Phase 2 — sandbox leases: the ONE entry point for borrowing a
 * sandbox. Requests are explicit (docs/0010's "explicit options at the
 * SDK layer, knobs above"); defaults — plain chats none, project chats
 * dedicated-on-first-use, machine runs dedicated at start, attach only
 * by explicit choice — are layered above this in the callers.
 *
 *   dedicated: this owner's own sandbox, created on first acquire,
 *              resumed if idle-stopped, reused after. Own ports and
 *              processes.
 *   attach:    join someone else's sandbox — own workdir under
 *              /work/<conversationId>, knowingly shared ports/processes.
 */

export type AcquireRequest =
  | {
      mode: "dedicated";
      ownerKind: SandboxOwnerKind;
      ownerId: string;
      projectId: string | null;
      /** Work root override (machine runs keep /work/<runId>). */
      root?: string;
    }
  | {
      mode: "attach";
      sandboxId: string;
      conversationId: string;
    };

export interface AcquiredSandbox {
  sandboxId: string;
  handle: SandboxHandle;
}

export async function acquireSandbox(
  request: AcquireRequest,
  provider: SandboxProvider = sandboxProvider(),
): Promise<AcquiredSandbox> {
  if (request.mode === "attach") {
    return acquireAttached(request.sandboxId, request.conversationId, provider);
  }
  return acquireDedicated(request, provider);
}

async function acquireDedicated(
  request: Extract<AcquireRequest, { mode: "dedicated" }>,
  provider: SandboxProvider,
): Promise<AcquiredSandbox> {
  const existing = getLeaseByOwner(db(), request.ownerKind, request.ownerId);
  if (existing && existing.provider !== provider.kind) {
    throw new Error(
      `sandbox for ${request.ownerKind} ${request.ownerId} belongs to provider "${existing.provider}", not "${provider.kind}"`,
    );
  }

  if (!existing) {
    // creating → running around the provider call; a crash between the
    // two leaves a "creating" row the reaper sweeps (never acquired).
    const lease = insertLease(db(), {
      provider: provider.kind,
      ownerKind: request.ownerKind,
      ownerId: request.ownerId,
      projectId: request.projectId,
    });
    try {
      const handle = await provider.create({
        projectId: request.projectId,
        root: request.root ?? sandboxWorkRoot(request.ownerId),
        namePrefix: request.ownerId,
      });
      updateLease(db(), lease.id, { ref: handle.ref, status: "running" });
      return { sandboxId: lease.id, handle };
    } catch (err) {
      deleteLease(db(), lease.id);
      throw err;
    }
  }

  const root = request.root ?? sandboxWorkRoot(request.ownerId);
  if (existing.status === "stopped") {
    await provider.resume(existing.ref);
    updateLease(db(), existing.id, { status: "running" });
  }
  touchLease(db(), existing.id);
  return { sandboxId: existing.id, handle: provider.attach(existing.ref, root) };
}

async function acquireAttached(
  sandboxId: string,
  conversationId: string,
  provider: SandboxProvider,
): Promise<AcquiredSandbox> {
  const lease = getLease(db(), sandboxId);
  if (!lease || lease.status === "destroyed") throw new Error(`no sandbox ${sandboxId}`);
  const workdir = sandboxWorkRoot(conversationId);
  if (lease.status === "stopped") {
    await provider.resume(lease.ref);
    updateLease(db(), lease.id, { status: "running" });
  }
  upsertAttachment(db(), {
    sandboxId: lease.id,
    conversationId,
    workdir,
  });
  touchLease(db(), lease.id);
  // The attacher gets its own workdir (created lazily by the first
  // command that needs it; mkdir on every attach would race nothing).
  // The mkdir runs from "/" — the handle's default cwd is the workdir
  // itself, which does not exist until this command succeeds.
  const handle = provider.attach(lease.ref, workdir);
  await handle
    .run(`mkdir -p ${JSON.stringify(workdir)}`, undefined, "/")
    .catch(() => undefined);
  return { sandboxId: lease.id, handle };
}

/**
 * Destroy a lease (owner deleted, long-idle reaping, or a machine run's
 * explicit end-of-run teardown): remove the sandbox and mark the registry
 * row destroyed (0011 — the row stays so recorded calls keep a target).
 */
export async function destroySandbox(
  sandboxId: string,
  provider: SandboxProvider = sandboxProvider(),
): Promise<void> {
  const lease = getLease(db(), sandboxId);
  if (!lease || lease.status === "destroyed") return;
  await provider.destroy(lease.ref);
  markDestroyed(db(), lease.id);
}
