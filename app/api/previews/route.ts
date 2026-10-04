import { NextResponse } from "next/server";
import { db } from "@/db";
import { listPreviews, listPreviewsForSandboxes } from "@/db/previews";
import { getConversationBinding } from "@/db/sandboxes";
import { machineRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createBranchPreview } from "@/lib/previews/branch";
import { PreviewError, viewPreview } from "@/lib/previews/service";

export const dynamic = "force-dynamic";

/**
 * 0016: previews. `?owner=<conversation or run id>` lists the previews in
 * that chat's or run's bound sandbox (what its header pill shows — the
 * whole tree shares the binding, 0013); `?sandbox=<sbx_…>` one sandbox's;
 * no filter, every preview not deleted.
 */
/**
 * 0017: create a branch preview — `{ projectId, repoId, branch,
 * workDir?, install?, command?, port?, label?, saveSetup? }`. With the
 * project's saved setup (or explicit values) it returns once serving or
 * parked as failed; otherwise it provisions and returns `candidates`
 * for the Discover step (the row waits in `provisioning` for a confirm).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === "string" && (body[k] as string).trim() ? (body[k] as string).trim() : undefined);
  const projectId = str("projectId");
  const repoId = str("repoId");
  const branch = str("branch");
  if (!projectId || !repoId || !branch) {
    return NextResponse.json({ error: "projectId, repoId and branch are required" }, { status: 400 });
  }
  const port = body.port === undefined || body.port === "" ? undefined : Number(body.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    return NextResponse.json({ error: "port must be 1–65535" }, { status: 400 });
  }
  try {
    const result = await createBranchPreview({
      projectId,
      repoId,
      branch,
      ...(str("workDir") ? { workDir: str("workDir") } : {}),
      ...(str("install") ? { install: str("install") } : {}),
      ...(str("command") ? { command: str("command") } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(str("label") ? { label: str("label") } : {}),
      ...(body.saveSetup === true ? { saveSetup: true } : {}),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PreviewError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}

export function GET(request: Request) {
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const sandbox = url.searchParams.get("sandbox");
  let previews;
  if (owner) {
    const sandboxId = boundSandbox(owner);
    previews = sandboxId ? listPreviewsForSandboxes(db(), [sandboxId]) : [];
  } else if (sandbox) {
    previews = listPreviewsForSandboxes(db(), [sandbox]);
  } else {
    previews = listPreviews(db());
  }
  return NextResponse.json({ previews: previews.map(viewPreview) });
}

function boundSandbox(owner: string): string | null {
  if (owner.startsWith("mr_")) {
    const runId = owner.replace(/_\d+$/, "");
    return db().select({ s: machineRuns.sandboxId }).from(machineRuns).where(eq(machineRuns.id, runId)).get()?.s ?? null;
  }
  const binding = getConversationBinding(db(), owner);
  return binding?.kind === "bound" ? binding.sandboxId : null;
}
