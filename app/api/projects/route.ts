import { NextResponse } from "next/server";
import { db } from "@/db";
import { createProject } from "@/db/projects";

export const dynamic = "force-dynamic";

/**
 * 0033 B-UI: create a project — the UI half of the createProject core
 * (the agent's create_project tool is the other half; 0015 pattern).
 * Same validation, value shapes mapped to status codes.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    repos?: unknown;
  };
  if (typeof body.id !== "string" || typeof body.name !== "string") {
    return NextResponse.json({ error: "id and name are required strings" }, { status: 400 });
  }
  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
    return NextResponse.json({ error: "description must be a string or null" }, { status: 400 });
  }
  const repos = Array.isArray(body.repos) ? body.repos : [];
  for (const repo of repos) {
    if (
      !repo ||
      typeof repo !== "object" ||
      typeof (repo as { name?: unknown }).name !== "string" ||
      typeof (repo as { url?: unknown }).url !== "string"
    ) {
      return NextResponse.json({ error: "repos must be {name, url} objects" }, { status: 400 });
    }
  }

  const result = createProject(db(), {
    id: body.id,
    name: body.name,
    description: (body.description as string | null) ?? null,
    repos: repos as { name: string; url: string }[],
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, code: result.code },
      { status: result.code === "conflict" ? 409 : 400 },
    );
  }
  return NextResponse.json({ project: result.project, repos: result.repos }, { status: 201 });
}
