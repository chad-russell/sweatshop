import { eq, inArray } from "drizzle-orm";
import type { Db } from "./index";
import { getConversation } from "./chat";
import { getLeaseByOwner, listCallsForConversation } from "./sandboxes";
import { conversations, machineRuns, sandboxes } from "./schema";

/**
 * 0011 phase 2: the chat's read-model of its sandboxes — what each
 * sandboxed tool call ran in, and where the NEXT one would run. Pure
 * reads over sandbox_calls / sandboxes / conversations; no invariants
 * live here (those are db/sandboxes.ts).
 */

export interface SandboxRef {
  id: string;
  status: string;
  /** Human label for the owner: a chat title or machine run name. */
  ownerLabel: string;
  ownerKind: string;
  ownerId: string;
  /** True when this conversation owns it (vs. joined someone else's). */
  own: boolean;
}

export interface CallSandbox {
  sandboxId: string;
  via: "dedicated" | "attached";
  /** The previous sandboxed call in this chat used a different sandbox. */
  changed: boolean;
}

/** Where the conversation's next sandboxed call would run. */
export type SandboxState =
  | { kind: "none" }
  /** No sandbox exists yet; one is created on first use. */
  | { kind: "pending" }
  /** Plain chat with no project and no attach: nothing to run in. */
  | { kind: "unavailable" }
  | { kind: "own"; sandboxId: string }
  | { kind: "attached"; sandboxId: string };

export interface ConversationSandboxView {
  state: SandboxState;
  /** toolCallId → the sandbox that call ran in. */
  calls: Record<string, CallSandbox>;
  /** Every sandbox referenced by `calls` or `state`, by id. */
  sandboxes: Record<string, SandboxRef>;
}

function ownerLabel(db: Db, ownerKind: string, ownerId: string): string {
  if (ownerKind === "machine_run") {
    const run = db
      .select({ name: machineRuns.machineName })
      .from(machineRuns)
      .where(eq(machineRuns.id, ownerId))
      .get();
    return run ? `${run.name} run` : ownerId;
  }
  const convo = db
    .select({ title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, ownerId))
    .get();
  return convo?.title ?? ownerId;
}

export function loadConversationSandboxView(
  db: Db,
  conversationId: string,
): ConversationSandboxView {
  const conversation = getConversation(db, conversationId);
  const calls = listCallsForConversation(db, conversationId);

  const callMap: Record<string, CallSandbox> = {};
  let previous: string | null = null;
  for (const call of calls) {
    callMap[call.toolCallId] = {
      sandboxId: call.sandboxId,
      via: call.via,
      changed: previous !== null && previous !== call.sandboxId,
    };
    previous = call.sandboxId;
  }

  const pref = conversation?.sandboxPref ?? null;
  let state: SandboxState;
  if (pref === "none") {
    state = { kind: "none" };
  } else if (pref?.startsWith("attached:")) {
    state = { kind: "attached", sandboxId: pref.slice("attached:".length) };
  } else {
    const own = getLeaseByOwner(db, "conversation", conversationId);
    state = own
      ? { kind: "own", sandboxId: own.id }
      : conversation?.projectId
        ? { kind: "pending" }
        : { kind: "unavailable" };
  }

  const ids = new Set(Object.values(callMap).map((c) => c.sandboxId));
  if (state.kind === "own" || state.kind === "attached") ids.add(state.sandboxId);

  const refs: Record<string, SandboxRef> = {};
  if (ids.size > 0) {
    const rows = db
      .select()
      .from(sandboxes)
      .where(inArray(sandboxes.id, [...ids]))
      .all();
    for (const row of rows) {
      refs[row.id] = {
        id: row.id,
        status: row.status,
        ownerKind: row.ownerKind,
        ownerId: row.ownerId,
        ownerLabel: ownerLabel(db, row.ownerKind, row.ownerId),
        own: row.ownerKind === "conversation" && row.ownerId === conversationId,
      };
    }
  }

  return { state, calls: callMap, sandboxes: refs };
}
