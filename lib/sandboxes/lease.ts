import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { markSandboxPreviewsStopped } from "@/db/previews";
import { projects, sandboxConfigs } from "@/db/schema";
import {
  deleteLease,
  getLease,
  getLeaseByOwner,
  insertLease,
  markDestroyed,
  touchLease,
  updateLease,
  type SandboxLease,
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
  const existing = getLeaseByOwner(db(), request.ownerKind, request.ownerId);
  if (!existing) {
    const sandboxId = mintDedicatedLease(request, provider);
    try {
      return { sandboxId, handle: await activateDedicatedLease({ ...request, sandboxId }, provider) };
    } catch (err) {
      // Nothing references an acquire-path lease yet (branch previews
      // mint their own), so remove it and a retry starts clean; if
      // something does reference it, keep the row as destroyed history.
      try {
        deleteLease(db(), sandboxId);
      } catch {
        markDestroyed(db(), sandboxId);
      }
      throw err;
    }
  }
  return { sandboxId: existing.id, handle: await resumeDedicatedLease(existing, request, provider) };
}

/**
 * 0017: mint a "creating" lease row without provisioning it yet.
 * Branch previews insert their preview row between mint and activate
 * (the FK needs the row) so a provisioning failure is a visible failed
 * preview, never an invisible 500. Throws if the owner already holds a
 * lease or the provider changed.
 */
export function mintDedicatedLease(
  request: AcquireRequest,
  provider: SandboxProvider = sandboxProvider(),
): string {
  const existing = getLeaseByOwner(db(), request.ownerKind, request.ownerId);
  if (existing) {
    if (existing.provider !== provider.kind) {
      throw new Error(
        `sandbox for ${request.ownerKind} ${request.ownerId} belongs to provider "${existing.provider}", not "${provider.kind}"`,
      );
    }
    throw new Error(`sandbox for ${request.ownerKind} ${request.ownerId} already exists`);
  }
  return insertLease(db(), {
    provider: provider.kind,
    ownerKind: request.ownerKind,
    ownerId: request.ownerId,
    projectId: request.projectId,
  }).id;
}

/**
 * 0017: activate a minted lease — create the container and its project
 * workspace. Cleanup on failure belongs to the CALLER (a branch
 * preview's row references the lease, so it marks it destroyed rather
 * than deleting; the acquire path deletes); a hard crash mid-create
 * leaves the "creating" row for the reaper, as before.
 */
export async function activateDedicatedLease(
  request: AcquireRequest & { sandboxId: string },
  provider: SandboxProvider = sandboxProvider(),
): Promise<SandboxHandle> {
  const image = request.projectId ? projectSandboxImage(request.projectId) : null;
  const handle = await provider.create({
    projectId: request.projectId,
    root: request.root ?? sandboxWorkRoot(request.ownerId),
    namePrefix: request.ownerId,
    ...(image ? { image } : {}),
  });
  updateLease(db(), request.sandboxId, { ref: handle.ref, status: "running" });
  return handle;
}

async function resumeDedicatedLease(
  existing: SandboxLease,
  request: AcquireRequest,
  provider: SandboxProvider,
): Promise<SandboxHandle> {
  if (existing.provider !== provider.kind) {
    throw new Error(
      `sandbox for ${request.ownerKind} ${request.ownerId} belongs to provider "${existing.provider}", not "${provider.kind}"`,
    );
  }
  const root = request.root ?? sandboxWorkRoot(request.ownerId);
  if (existing.status === "stopped") {
    await provider.resume(existing.ref);
    updateLease(db(), existing.id, { status: "running" });
  }
  touchLease(db(), existing.id);
  return provider.attach(existing.ref, root);
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
  markSandboxPreviewsStopped(db(), lease.id);
}
