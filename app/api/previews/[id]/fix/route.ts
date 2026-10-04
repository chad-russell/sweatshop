import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { db } from "@/db";
import { ensureConversation } from "@/db/chat";
import { renameConversation } from "@/db/organize";
import { getPreview } from "@/db/previews";
import { getLease } from "@/db/sandboxes";
import { startChatTurn } from "@/lib/chat/start-turn";
import { attachConversation } from "@/lib/sandboxes/binding";
import { previewLogs } from "@/lib/previews/service";

export const dynamic = "force-dynamic";

/**
 * 0016 "Fix it": a new chat ATTACHED to the failed preview's sandbox
 * (0013 — same sandbox, same directory), seeded with the failure, its
 * first turn started here. The agent may fix local causes and restart
 * the preview; a fix that belongs in the branch it reports instead of
 * pushing to someone else's branch.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = getPreview(db(), id);
  if (!p || p.deletedAt) return NextResponse.json({ error: `no preview ${id}` }, { status: 404 });
  const lease = getLease(db(), p.sandboxId);
  if (!lease || lease.status === "destroyed") {
    return NextResponse.json({ error: "this preview's sandbox was destroyed — delete and recreate the preview" }, { status: 409 });
  }

  const conversationId = `c_${nanoid()}`;
  ensureConversation(db(), conversationId, lease.projectId);
  await attachConversation(conversationId, p.sandboxId);
  renameConversation(db(), conversationId, `Fix preview ${p.label ?? p.branch ?? p.slug}`);

  const log = await previewLogs(p.id, 120).catch(() => "");
  const text = [
    `The branch preview **${p.label ?? p.branch}** (${p.id}) failed${p.failedSha && p.failedSha !== "create" ? ` at \`${p.failedSha.slice(0, 7)}\`` : ""}.`,
    `It follows branch \`${p.branch}\`, checked out at \`${p.workDir}\` in this sandbox, served by \`${p.command}\` on port ${p.port}.`,
    "",
    "Follower's error:",
    "```",
    (p.error ?? "(none recorded)").slice(-3_000),
    "```",
    log.trim() ? ["Server log tail:", "```", log.trim().slice(-4_000), "```"].join("\n") : "",
    "",
    "Find the cause. If it is local to this preview (missing env, stale cache, install hiccup), fix it and bring the server back with start_preview (same dir and port restarts this preview). " +
      "If the fix belongs in the branch itself, do NOT push to it — explain what is wrong and what the change should be.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  await startChatTurn(conversationId, text);
  return NextResponse.json({ conversationId, url: `/c/${conversationId}` });
}
