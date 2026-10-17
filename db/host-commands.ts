import { desc, eq } from "drizzle-orm";
import type { Db } from "./index";
import { hostCommands } from "./schema";

/**
 * 0043: the exec audit trail. A row is written BEFORE the command runs
 * (`recordHostCommand`) and resolved after (`resolveHostCommand`) — a
 * crash mid-command still shows the attempt. This table is the raw
 * material the deferred policy modes (0043 "Explicitly deferred") will
 * be designed against, so it is append-mostly and never rewritten.
 */

export interface NewHostCommand {
  id: string;
  conversationId: string;
  hostId: string;
  hostName: string;
  command: string;
  /** 0043 amendment: this command skipped ask_chad under the chat's
   *  auto-approve toggle. Default false — an explicit approval. */
  autoApproved?: boolean;
}

export function recordHostCommand(db: Db, row: NewHostCommand): void {
  db.insert(hostCommands)
    .values({ ...row, createdAt: Date.now() })
    .run();
}

export function resolveHostCommand(
  db: Db,
  id: string,
  result: { exitCode: number | null; output: string; durationMs: number },
): void {
  // Settles are one-way: the first final write wins (crash-recovery
  // semantics — a retried step must not clobber the recorded outcome).
  db.update(hostCommands)
    .set({ ...result, resolvedAt: Date.now() })
    .where(eq(hostCommands.id, id))
    .run();
}

/** A conversation's host commands, newest first (inspect's view). */
export function listHostCommands(db: Db, conversationId: string, limit = 10) {
  return db
    .select()
    .from(hostCommands)
    .where(eq(hostCommands.conversationId, conversationId))
    .orderBy(desc(hostCommands.id))
    .limit(limit)
    .all();
}
