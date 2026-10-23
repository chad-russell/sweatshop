import { db } from "@/db";
import {
  bindConversation,
  getConversationBinding,
  getLease,
  touchLease,
  updateLease,
  upsertAttachment,
  type BoundSandbox,
} from "@/db/sandboxes";
import { acquireSandbox } from "@/lib/sandboxes/lease";
import { sandboxWorkRoot } from "@/lib/sandboxes/provision";
import {
  sandboxProvider,
  type SandboxHandle,
  type SandboxProvider,
} from "@/lib/sandboxes/provider";
import { loadProjectPlan } from "@/lib/sandboxes/workspace";

export type { BoundSandbox, SandboxBinding } from "@/db/sandboxes";

/**
 * 0013: sandbox bindings, live side. A top-level chat or run picks its
 * sandbox once; every step that needs it turns the binding into a live
 * handle here. Nothing below the top level picks or changes a sandbox.
 */

export interface OpenedSandbox {
  sandboxId: string;
  workDir: string;
  handle: SandboxHandle;
}

/**
 * Turn a bound binding into a live handle: resumes an idle-stopped
 * sandbox and bumps its last use. Never creates, stops, or destroys.
 */
export async function openSandbox(
  binding: BoundSandbox,
  provider: SandboxProvider = sandboxProvider(),
): Promise<OpenedSandbox> {
  const lease = getLease(db(), binding.sandboxId);
  if (!lease || lease.status === "destroyed") {
    throw new Error(
      `this conversation's sandbox (${binding.sandboxId}) was destroyed — ` +
        `a binding never changes, so start a new chat to get a fresh sandbox`,
    );
  }
  if (lease.provider !== provider.kind) {
    throw new Error(
      `sandbox ${lease.id} belongs to provider "${lease.provider}", not "${provider.kind}"`,
    );
  }
  if (lease.status === "stopped") {
    await provider.resume(lease.ref);
    updateLease(db(), lease.id, { status: "running" });
  }
  touchLease(db(), lease.id);
  return {
    sandboxId: lease.id,
    workDir: binding.workDir,
    handle: provider.attach(lease.ref, binding.workDir),
  };
}

/**
 * Open an inherited binding on behalf of a session that does not own a
 * stored binding (a machine agent stage's visit conversation). Same
 * open, never binds or changes lifecycle.
 */
export async function openInheritedSandbox(
  binding: BoundSandbox,
  provider: SandboxProvider = sandboxProvider(),
): Promise<OpenedSandbox> {
  return openSandbox(binding, provider);
}

/** The copy an attacher or child gets: same sandbox, same directory —
 *  unless `workDir` overrides it (0082: a start_thread child dropped at
 *  the bare work root of a single-repo project). */
export function inheritBinding(binding: BoundSandbox, workDir: string = binding.workDir): BoundSandbox {
  return { kind: "bound", sandboxId: binding.sandboxId, workDir, owner: false };
}

/**
 * 0082: a start_thread child attached to its parent's sandbox normally
 * inherits the EXACT same directory (same sandbox, same cwd) — but a
 * parent still sitting at the bare work root (never `cd`'d into
 * anything) hands the child nothing to work in when the project has
 * exactly one repo: the clone lives at `<root>/<repoName>`, and the
 * child has to find that itself. Pick the repo subdirectory for it in
 * that one case. A parent already inside a repo (or any other
 * subdirectory), a multi-repo project (no single right answer to pick),
 * or no project at all, are left untouched.
 */
export function childSandboxWorkDir(ownerId: string, workDir: string, projectId: string | null): string {
  if (!projectId || workDir !== sandboxWorkRoot(ownerId)) return workDir;
  const plan = loadProjectPlan(projectId);
  if (!plan || plan.repos.length !== 1) return workDir;
  return `${workDir}/${plan.repos[0]!.name}`;
}

/**
 * The bound binding of a sandbox, as its owner holds it — what attaching
 * copies. Owners are conversations (their stored binding) or machine
 * runs (their run work root; phase 3 stores runs' bindings too).
 */
export function ownerBinding(sandboxId: string): BoundSandbox {
  const lease = getLease(db(), sandboxId);
  if (!lease || lease.status === "destroyed") throw new Error(`no sandbox ${sandboxId}`);
  if (lease.ownerKind === "conversation") {
    const owner = getConversationBinding(db(), lease.ownerId);
    if (owner?.kind === "bound" && owner.sandboxId === lease.id) return owner;
  }
  return { kind: "bound", sandboxId: lease.id, workDir: sandboxWorkRoot(lease.ownerId), owner: true };
}

/**
 * The conversation's sandbox, bound on first use: a pending project chat
 * creates its own sandbox (once — later calls reuse the stored binding),
 * a bound one opens what it is bound to, and "none" refuses.
 */
export async function openConversationSandbox(
  conversationId: string,
  provider: SandboxProvider = sandboxProvider(),
): Promise<OpenedSandbox & { binding: BoundSandbox }> {
  const binding = await bindOnFirstUse(conversationId, provider);
  const opened = await openSandbox(binding, provider);
  return { ...opened, binding };
}

async function bindOnFirstUse(
  conversationId: string,
  provider: SandboxProvider,
): Promise<BoundSandbox> {
  const binding = getConversationBinding(db(), conversationId);
  if (!binding) throw new Error(`no conversation ${conversationId}`);
  if (binding.kind === "bound") return binding;
  if (binding.kind === "none") {
    throw new Error(
      "this conversation has no sandbox — sandboxed tools need a project conversation " +
        "(start one from a project page) or a chat started attached to a sandbox",
    );
  }
  // pending → bound, once. acquireSandbox is idempotent per owner (a
  // retried step finds the lease it created), and bindConversation keeps
  // whichever binding landed first.
  const workDir = sandboxWorkRoot(conversationId);
  const { sandboxId } = await acquireSandbox(
    { mode: "dedicated", ownerKind: "conversation", ownerId: conversationId, projectId: binding.projectId, root: workDir },
    provider,
  );
  return bindConversation(db(), conversationId, { kind: "bound", sandboxId, workDir, owner: true });
}

/**
 * Attach a fresh, unbound conversation to an existing sandbox: copy the
 * owner's binding (same sandbox, same directory). Refused once the
 * conversation is bound or disabled — the choice is made at the start.
 * 0082: `projectId` set (a start_thread child only) adjusts the inherited
 * workDir via childSandboxWorkDir; omitted (every other attacher — the
 * UI sandbox picker, previews' fix flow) keeps the exact same directory,
 * as before.
 */
export async function attachConversation(
  conversationId: string,
  sandboxId: string,
  provider: SandboxProvider = sandboxProvider(),
  projectId: string | null = null,
): Promise<BoundSandbox> {
  const current = getConversationBinding(db(), conversationId);
  if (!current) throw new Error(`no conversation ${conversationId}`);
  if (current.kind === "none" && current.disabled) {
    throw new Error("this conversation was started with no sandbox");
  }
  if (current.kind === "bound") {
    if (current.sandboxId === sandboxId) return current;
    throw new Error(
      "this conversation is already bound to a sandbox — a binding never changes; start a new chat to use another",
    );
  }
  const owner = ownerBinding(sandboxId);
  const lease = getLease(db(), sandboxId);
  const workDir = lease ? childSandboxWorkDir(lease.ownerId, owner.workDir, projectId) : owner.workDir;
  const target = inheritBinding(owner, workDir);
  const bound = bindConversation(db(), conversationId, target);
  if (bound.sandboxId !== sandboxId) {
    throw new Error("this conversation was bound to another sandbox first");
  }
  upsertAttachment(db(), { sandboxId, conversationId, workdir: bound.workDir });
  await openSandbox(bound, provider);
  return bound;
}

/**
 * 0013: destroy sandboxes a purge released (owned by the purged run).
 * Best-effort: a failure leaves the sandbox to the reaper's run window.
 */
export async function destroyOwnedSandboxes(
  sandboxIds: string[],
  provider: SandboxProvider = sandboxProvider(),
): Promise<void> {
  if (sandboxIds.length === 0) return;
  const { destroySandbox } = await import("@/lib/sandboxes/lease");
  for (const id of sandboxIds) {
    await destroySandbox(id, provider).catch((err: unknown) => {
      console.error(`[sandboxes] could not destroy purged run sandbox ${id}`, err);
    });
  }
}
