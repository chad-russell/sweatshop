import { NextResponse } from "next/server";
import { db } from "@/db";
import { listPreviews, listPreviewsForSandboxes } from "@/db/previews";
import { getConversationBinding } from "@/db/sandboxes";
import { machineRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import { viewPreview } from "@/lib/previews/service";

export const dynamic = "force-dynamic";

/**
 * 0016: previews. `?owner=<conversation or run id>` lists the previews in
 * that chat's or run's bound sandbox (what its header pill shows — the
 * whole tree shares the binding, 0013); `?sandbox=<sbx_…>` one sandbox's;
 * no filter, every preview not deleted.
 */
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
