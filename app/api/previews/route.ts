import { NextResponse } from "next/server";
import { db } from "@/db";
import { listPreviews, listPreviewsForSandboxes } from "@/db/previews";
import { getConversationBinding } from "@/db/sandboxes";
import { createBranchPreview } from "@/lib/previews/branch";
import { parsePreviewOverrides } from "@/lib/previews/overrides";
import { previewProjectId } from "@/lib/previews/context";
import { PreviewError, viewPreview } from "@/lib/previews/service";

export const dynamic = "force-dynamic";

/**
 * 0016: previews. `?owner=<conversation id>` lists the previews in that
 * chat's bound sandbox (what its header pill shows — the whole tree
 * shares the binding, 0013); `?sandbox=<sbx_…>` one sandbox's; no
 * filter, every preview not deleted.
 */
/**
 * 0017: create a branch preview — `{ projectId, repoId, branch,
 * workDir?, install?, command?, port?, label?, migrate?, seed?,
 * services?, env? }`. With the project's saved setup (or explicit
 * values) it returns once serving or parked as failed; otherwise it
 * provisions and returns `candidates` for the Discover step (the row
 * waits in `provisioning` for a confirm, which saves the project's
 * first setup — an existing one is never written from here, 0019).
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
  const parsed = parsePreviewOverrides(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return NextResponse.json(await createBranchPreview({ projectId, repoId, branch, ...parsed.overrides }));
  } catch (err) {
    if (err instanceof PreviewError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}

export function GET(request: Request) {
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const sandbox = url.searchParams.get("sandbox");
  const project = url.searchParams.get("project");
  let previews;
  if (owner) {
    const sandboxId = boundSandbox(owner);
    previews = sandboxId ? listPreviewsForSandboxes(db(), [sandboxId]) : [];
  } else if (sandbox) {
    previews = listPreviewsForSandboxes(db(), [sandbox]);
  } else if (project) {
    // 0018: a project's previews — branch rows through their repo,
    // worktree rows through their sandbox's owner (previewProjectId).
    previews = listPreviews(db()).filter((p) => previewProjectId(p) === project);
  } else {
    previews = listPreviews(db());
  }
  return NextResponse.json({ previews: previews.map(viewPreview) });
}

function boundSandbox(owner: string): string | null {
  const binding = getConversationBinding(db(), owner);
  return binding?.kind === "bound" ? binding.sandboxId : null;
}
