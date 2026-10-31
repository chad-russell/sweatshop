import { NextResponse } from "next/server";
import { installCatalogSkill, previewCatalogSkill } from "@/lib/skills/catalog-source";

export const dynamic = "force-dynamic";

/**
 * 0090 §7: one catalog skill — GET is the trust surface (the raw
 * SKILL.md plus the file manifest with sizes, contents withheld), POST
 * installs it into the store. Value-shaped throughout; only a malformed
 * POST body 400s.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const source = new URL(request.url).searchParams.get("source") ?? "anthropics";
  const res = await previewCatalogSkill(source, id);
  return NextResponse.json(
    res.ok
      ? {
          ok: true as const,
          skill: {
            id: res.skill.id,
            raw: res.skill.raw,
            sha: res.skill.sha,
            files: res.skill.files.map((file) => ({
              path: file.path,
              size: new TextEncoder().encode(file.content).byteLength,
            })),
          },
        }
      : res,
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { source?: unknown };
  if (body.source !== undefined && typeof body.source !== "string") {
    return NextResponse.json({ error: "source must be a string" }, { status: 400 });
  }
  return NextResponse.json(await installCatalogSkill(body.source ?? "anthropics", id));
}
