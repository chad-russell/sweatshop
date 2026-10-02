import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { projects, sandboxConfigs } from "@/db/schema";
import {
  deleteLease,
  getLease,
  getLeaseByOwner,
  insertLease,
  markDestroyed,
  touchLease,
  updateLease,
  type SandboxOwnerKind,
} from "@/db/sandboxes";
import { sandboxWorkRoot } from "@/lib/sandboxes/provision";
import {
  sandboxProvider,
  type SandboxHandle,
  type SandboxProvider,
} from "@/lib/sandboxes/provider";

/**
 * 0010 Phase 2 — sandbox leases: the ONE entry point for creating an
 * owner's sandbox. A dedicated lease is created on first acquire,
 * resumed if idle-stopped, and reused after. 0013: attaching is not a
 * lease mode any more — an attacher copies the owner's binding
 * (lib/sandboxes/binding.ts) and opens the same sandbox and directory.
 */

export type AcquireRequest = {
  mode: "dedicated";
  ownerKind: SandboxOwnerKind;
  ownerId: string;
  projectId: string | null;
  /** Work root override (machine runs keep /work/<runId>). */
  root?: string;
};

export interface AcquiredSandbox {
  sandboxId: string;
  handle: SandboxHandle;
}

export async function acquireSandbox(
  request: AcquireRequest,
  provider: SandboxProvider = sandboxProvider(),
): Promise<AcquiredSandbox> {
  return acquireDedicated(request, provider);
}

async function acquireDedicated(
  request: AcquireRequest,
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
      const image = request.projectId ? projectSandboxImage(request.projectId) : null;
      const handle = await provider.create({
        projectId: request.projectId,
        root: request.root ?? sandboxWorkRoot(request.ownerId),
        namePrefix: request.ownerId,
        ...(image ? { image } : {}),
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

/**
 * 0013: the image a project's sandboxes run — its sandbox config's
 * `image_ref` (a project with no config uses the "default" config).
 * Null = the provider default. `network_policy` stays recorded but
 * unenforced.
 */
export function projectSandboxImage(projectId: string): string | null {
  const row = db()
    .select({ imageRef: sandboxConfigs.imageRef })
    .from(projects)
    .leftJoin(
      sandboxConfigs,
      eq(sandboxConfigs.id, sql`coalesce(${projects.sandboxConfigId}, 'default')`),
    )
    .where(eq(projects.id, projectId))
    .get();
  return row?.imageRef?.trim() || null;
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
