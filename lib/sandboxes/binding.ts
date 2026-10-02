import { db } from "@/db";
import {
  bindConversation,
  getConversationBinding,
  getLease,
  recordSandboxCall,
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

/** The copy an attacher or child gets: same sandbox, same directory. */
export function inheritBinding(binding: BoundSandbox): BoundSandbox {
  return { kind: "bound", sandboxId: binding.sandboxId, workDir: binding.workDir, owner: false };
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

/** 0011: identifies the tool call to attribute to the sandbox it lands in. */
export interface CallAttribution {
  toolCallId: string;
  tool: "bash" | "pi" | "claude";
}

/**
 * The conversation's sandbox, bound on first use: a pending project chat
 * creates its own sandbox (once — later calls reuse the stored binding),
 * a bound one opens what it is bound to, and "none" refuses. Records the
 * call (0011) once the sandbox is in hand.
 */
export async function openConversationSandbox(
  conversationId: string,
  provider: SandboxProvider = sandboxProvider(),
  attribution?: CallAttribution,
): Promise<OpenedSandbox & { binding: BoundSandbox }> {
  const binding = await bindOnFirstUse(conversationId, provider);
  const opened = await openSandbox(binding, provider);
  if (attribution) {
    recordSandboxCall(db(), {
      toolCallId: attribution.toolCallId,
      sandboxId: opened.sandboxId,
      conversationId,
      tool: attribution.tool,
      via: binding.owner ? "dedicated" : "attached",
      workdir: binding.workDir,
    });
  }
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
 */
export async function attachConversation(
  conversationId: string,
  sandboxId: string,
  provider: SandboxProvider = sandboxProvider(),
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
  const target = inheritBinding(ownerBinding(sandboxId));
  const bound = bindConversation(db(), conversationId, target);
  if (bound.sandboxId !== sandboxId) {
    throw new Error("this conversation was bound to another sandbox first");
  }
  upsertAttachment(db(), { sandboxId, conversationId, workdir: bound.workDir });
  await openSandbox(bound, provider);
  return bound;
}
