import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sandboxServices } from "./schema";
import type { Db } from "./index";

/**
 * 0017 declared services: the registry half of the split. The
 * substrate (containers) is the truth; these rows are bookkeeping,
 * keyed (sandbox, name) — one set per sandbox, exactly what the setup
 * declares. Never deleted: destroyed rows stay as history.
 */

export type SandboxServiceStatus = "creating" | "running" | "stopped" | "destroyed";

export interface SandboxService {
  id: string;
  sandboxId: string;
  name: string;
  image: string;
  ref: string;
  status: SandboxServiceStatus;
  port: number;
  createdAt: number;
  updatedAt: number;
}

type Row = typeof sandboxServices.$inferSelect;

function hydrate(row: Row): SandboxService {
  return { ...row, status: row.status as SandboxService["status"] };
}

export function insertService(
  db: Db,
  input: { sandboxId: string; name: string; image: string; ref: string; port: number },
): SandboxService {
  const now = Date.now();
  const row = { id: `ssvc_${nanoid()}`, ...input, status: "creating" as const, createdAt: now, updatedAt: now };
  db.insert(sandboxServices).values(row).run();
  return hydrate(row);
}

export function getService(db: Db, sandboxId: string, name: string): SandboxService | null {
  const row = db
    .select()
    .from(sandboxServices)
    .where(eq(sandboxServices.sandboxId, sandboxId))
    .all()
    .find((r) => r.name === name);
  return row ? hydrate(row) : null;
}

export function listSandboxServices(db: Db, sandboxId: string): SandboxService[] {
  return db
    .select()
    .from(sandboxServices)
    .where(eq(sandboxServices.sandboxId, sandboxId))
    .all()
    .map(hydrate)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function updateService(
  db: Db,
  id: string,
  set: Partial<Pick<SandboxService, "ref" | "status">>,
): void {
  db.update(sandboxServices)
    .set({ ...set, updatedAt: Date.now() })
    .where(eq(sandboxServices.id, id))
    .run();
}

/** The sandbox is gone: its services' rows close out as history. */
export function markSandboxServicesDestroyed(db: Db, sandboxId: string): void {
  db.update(sandboxServices)
    .set({ status: "destroyed", updatedAt: Date.now() })
    .where(eq(sandboxServices.sandboxId, sandboxId))
    .run();
}
