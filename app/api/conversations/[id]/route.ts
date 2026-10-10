import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { destroyOwnedSandboxes } from "@/lib/sandboxes/binding";
import {
  OrganizeError,
  deleteConversationForever,
  moveConversation,
  renameConversation,
  setArchived,
  setTrashed,
} from "@/db/organize";
import { conversations } from "@/db/schema";
import {
  nullableString,
  optionalBoolean,
  organizeErrorResponse,
  readBody,
} from "@/lib/api-organize";

export const dynamic = "force-dynamic";

/**
 * Organize one conversation (0007):
 * `{ title?, folderId?: string|null, archived?: boolean, trashed?: boolean }`.
 * (0012 also cancelled a live run on trash; machines were deleted by
 * 0037 phase 5 — no run can be live.)
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await readBody(request);
    if (typeof body.title === "string") renameConversation(db(), id, body.title);
    const folderId = nullableString(body, "folderId");
    if (folderId !== undefined) moveConversation(db(), id, folderId);
    const archived = optionalBoolean(body, "archived");
    if (archived !== undefined) setArchived(db(), id, archived);
    const trashed = optionalBoolean(body, "trashed");
    if (trashed !== undefined) setTrashed(db(), id, trashed);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return organizeErrorResponse(err);
  }
}

/** Delete forever — only allowed once the conversation is in the Trash. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const row = db()
      .select({ trashedAt: conversations.trashedAt })
      .from(conversations)
      .where(eq(conversations.id, id))
      .get();
    if (!row) throw new OrganizeError("not-found", `conversation ${id} not found`);
    if (row.trashedAt === null) {
      throw new OrganizeError("invalid", "move to trash before deleting forever");
    }
    // 0013: a purged run takes its own sandbox with it.
    await destroyOwnedSandboxes(deleteConversationForever(db(), id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return organizeErrorResponse(err);
  }
}

