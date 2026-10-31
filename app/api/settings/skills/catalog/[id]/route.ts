import { NextResponse } from "next/server";
import {
  installCatalogSkill,
  installSearchSkill,
  parseSkillOrigin,
  previewCatalogSkill,
  previewSearchSkill,
  type SkillOrigin,
} from "@/lib/skills/catalog-source";

export const dynamic = "force-dynamic";

/** One origin's preview — the trust surface (raw SKILL.md plus the file
 * manifest with sizes, contents withheld). */
function preview(origin: SkillOrigin, id: string) {
  return origin.origin === "source"
    ? previewCatalogSkill(origin.source, id)
    : previewSearchSkill(origin.repo, origin.path);
}

function install(origin: SkillOrigin, id: string) {
  return origin.origin === "source"
    ? installCatalogSkill(origin.source, id)
    : installSearchSkill(origin.repo, origin.path);
}

/** The response shape both origins share. */
async function previewResponse(res: Awaited<ReturnType<typeof preview>>) {
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

/**
 * 0090 §7 + 0091 §1: one catalog skill — GET is the trust surface, POST
 * installs it into the store. The origin is either a curated source
 * (query/body `source`, anthropics default) or a search hit
 * (`{origin: "search", repo, path}` — for GET the origin/repo/path come
 * as query params, for POST in the JSON body). Value-shaped throughout;
 * 400 only for a malformed body or origin.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const searchParams = new URL(request.url).searchParams;
  const origin = parseSkillOrigin({
    origin: searchParams.get("origin") ?? undefined,
    source: searchParams.get("source") ?? undefined,
    repo: searchParams.get("repo") ?? undefined,
    path: searchParams.get("path") ?? undefined,
  });
  if (!origin.ok) return NextResponse.json({ error: origin.message }, { status: 400 });
  return previewResponse(await preview(origin.value, id));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    origin?: unknown;
    source?: unknown;
    repo?: unknown;
    path?: unknown;
  };
  const origin = parseSkillOrigin(body);
  if (!origin.ok) return NextResponse.json({ error: origin.message }, { status: 400 });
  return NextResponse.json(await install(origin.value, id));
}
