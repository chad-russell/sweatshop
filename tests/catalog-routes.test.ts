import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as listRoute } from "../app/api/settings/skills/catalog/route";
import { GET as searchRoute } from "../app/api/settings/skills/catalog/search/route";
import { GET as previewRoute, POST as installRoute } from "../app/api/settings/skills/catalog/[id]/route";
import { db } from "../db";
import { gitCredentials } from "../db/schema";
import { __resetCatalogCacheForTests } from "../lib/skills/catalog-source";
import { __setGatewayForTests, readSkill } from "../lib/skills/store";
import { FakeBucket } from "./helpers/fake-bucket";

/**
 * 0090 §7: the catalog routes — handlers directly, GitHub fetch stubbed
 * with one canned repo/tree/raw set, the S3 side on the fake bucket.
 */

const RAW_PDF = "---\nname: pdf\ndescription: Make PDFs\n---\n# PDFs\n\nDo it.\n";
const OPENCLAW_SHA = "feedface1234567890";
const TREE = {
  tree: [
    { path: "skills/pdf/SKILL.md", type: "blob", size: RAW_PDF.length },
    { path: "skills/pdf/ref.md", type: "blob", size: 7 },
  ],
};

let bucket: FakeBucket;
const realFetch = globalThis.fetch;

beforeEach(() => {
  bucket = new FakeBucket();
  __setGatewayForTests(bucket);
  __resetCatalogCacheForTests();
  db().delete(gitCredentials).run();
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u === "https://api.github.com/repos/anthropics/skills") {
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }
    if (u.startsWith("https://api.github.com/repos/anthropics/skills/git/trees/")) {
      return new Response(JSON.stringify(TREE), { status: 200 });
    }
    if (u.startsWith("https://skillsmp.com/api/v1/skills/search")) {
      const page = Number(new URL(u).searchParams.get("page"));
      const rows = [{ name: "Nano PDF", author: "openclaw", description: "Tiny", stars: 3, githubUrl: `https://github.com/openclaw/openclaw/tree/main/skills/pdf${page === 2 ? "-2" : ""}` }];
      return new Response(JSON.stringify({ success: true, data: { skills: rows } }), { status: 200 });
    }
    if (u === "https://api.github.com/repos/openclaw/openclaw") {
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }
    if (u === "https://api.github.com/repos/openclaw/openclaw/commits/main") {
      return new Response(JSON.stringify({ sha: OPENCLAW_SHA }), { status: 200 });
    }
    if (u.startsWith(`https://api.github.com/repos/openclaw/openclaw/git/trees/${OPENCLAW_SHA}`)) {
      return new Response(JSON.stringify(TREE), { status: 200 });
    }
    if (u === `https://raw.githubusercontent.com/openclaw/openclaw/${OPENCLAW_SHA}/skills/pdf/SKILL.md`) {
      return new Response(RAW_PDF, { status: 200 });
    }
    if (u === `https://raw.githubusercontent.com/openclaw/openclaw/${OPENCLAW_SHA}/skills/pdf/ref.md`) {
      return new Response("ref doc", { status: 200 });
    }
    if (u.endsWith("/skills/pdf/SKILL.md")) return new Response(RAW_PDF, { status: 200 });
    if (u.endsWith("/skills/pdf/ref.md")) return new Response("ref doc", { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __setGatewayForTests(null);
});

describe("GET /api/settings/skills/catalog (0090 §7)", () => {
  it("lists the source's skills", async () => {
    const res = await listRoute(new Request("http://local/api/settings/skills/catalog?source=anthropics"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      truncated: false,
      skills: [{ id: "pdf", description: "Make PDFs", fileCount: 2, sizeBytes: RAW_PDF.length + 7 }],
    });
  });

  it("defaults the source to anthropics; an unknown source is a 200 value", async () => {
    const res = await listRoute(new Request("http://local/api/settings/skills/catalog"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });

    const unknown = await listRoute(new Request("http://local/api/settings/skills/catalog?source=nope"));
    expect(unknown.status).toBe(200);
    await expect(unknown.json()).resolves.toMatchObject({ ok: false });
  });
});

describe("GET /api/settings/skills/catalog/[id] (0090 §7)", () => {
  it("previews the raw SKILL.md with file sizes, contents withheld", async () => {
    const res = await previewRoute(new Request("http://local"), { params: Promise.resolve({ id: "pdf" }) });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      skill: { id: "pdf", raw: RAW_PDF, sha: "main", files: [{ path: "ref.md", size: 7 }] },
    });
  });

  it("an unknown id is a 200 value", async () => {
    const res = await previewRoute(new Request("http://local"), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: false, code: "unknown-skill" });
  });
});

describe("POST /api/settings/skills/catalog/[id] (0090 §7)", () => {
  const post = (body: unknown) =>
    installRoute(
      new Request("http://local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: "pdf" }) },
    );

  it("installs into the store with provenance; name: normalized out", async () => {
    const res = await post({ source: "anthropics" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, id: "pdf" });
    const skill = await readSkill("pdf");
    expect(skill?.raw).toBe("---\ndescription: Make PDFs\n---\n# PDFs\n\nDo it.\n");
    expect(skill?.source).toEqual({ repo: "anthropics/skills", ref: "main", path: "skills/pdf" });
  });

  it("a colliding local id and a malformed body are honest", async () => {
    bucket.seed("pdf", "---\ndescription: Local\n---\n# Local\n");
    const res = await post({ source: "anthropics" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: false, code: "id-exists" });

    const malformed = await installRoute(
      new Request("http://local", { method: "POST", body: JSON.stringify({ source: 7 }) }),
      { params: Promise.resolve({ id: "pdf" }) },
    );
    expect(malformed.status).toBe(400);
  });
});

describe("GET /api/settings/skills/catalog/search (0091 §1)", () => {
  it("searches SkillsMP and maps rows to install targets", async () => {
    const res = await searchRoute(new Request("http://local/api/settings/skills/catalog/search?q=pdf"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      results: [
        { id: "pdf", name: "Nano PDF", author: "openclaw", description: "Tiny", stars: 3, repo: "openclaw/openclaw", path: "skills/pdf", ref: "main" },
        { id: "pdf-2", name: "Nano PDF", author: "openclaw", description: "Tiny", stars: 3, repo: "openclaw/openclaw", path: "skills/pdf-2", ref: "main" },
      ],
    });
  });

  it("a missing or empty q is a 400", async () => {
    expect((await searchRoute(new Request("http://local/api/settings/skills/catalog/search"))).status).toBe(400);
    expect((await searchRoute(new Request("http://local/api/settings/skills/catalog/search?q=%20"))).status).toBe(400);
  });
});

describe("search-origin params on [id] (0091 §1)", () => {
  it("GET origin=search previews at the pinned head sha", async () => {
    const res = await previewRoute(
      new Request("http://local?origin=search&repo=openclaw/openclaw&path=skills/pdf"),
      { params: Promise.resolve({ id: "pdf" }) },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      skill: { id: "pdf", sha: OPENCLAW_SHA },
    });
  });

  it("origin=search without repo is a 400; an unknown source is a 400", async () => {
    const noRepo = await previewRoute(new Request("http://local?origin=search&path=skills/pdf"), {
      params: Promise.resolve({ id: "pdf" }),
    });
    expect(noRepo.status).toBe(400);
    const badSource = await previewRoute(new Request("http://local?source=nope"), { params: Promise.resolve({ id: "pdf" }) });
    expect(badSource.status).toBe(400);
  });

  it("POST origin=search installs with provenance pinned to the sha", async () => {
    const res = await installRoute(
      new Request("http://local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "search", repo: "openclaw/openclaw", path: "skills/pdf" }),
      }),
      { params: Promise.resolve({ id: "pdf" }) },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, id: "pdf" });
    expect((await readSkill("pdf"))?.source).toEqual({ repo: "openclaw/openclaw", ref: OPENCLAW_SHA, path: "skills/pdf" });
  });

  it("POST origin=search missing repo is a 400", async () => {
    const res = await installRoute(
      new Request("http://local", { method: "POST", body: JSON.stringify({ origin: "search", path: "skills/pdf" }) }),
      { params: Promise.resolve({ id: "pdf" }) },
    );
    expect(res.status).toBe(400);
  });
});
