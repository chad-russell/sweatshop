import { NextResponse } from "next/server";
import { db } from "@/db";
import { loadConversationSandboxView } from "@/db/sandbox-view";

export const dynamic = "force-dynamic";

/**
 * 0011: where this conversation's sandboxed calls ran and where the next
 * one would — the chat surface's sandbox chips and header state.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return NextResponse.json(loadConversationSandboxView(db(), id));
}
