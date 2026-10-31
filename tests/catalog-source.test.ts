import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { gitCredentials } from "../db/schema";
import {
  __resetCatalogCacheForTests,
  catalogDescription,
  installCatalogSkill,
  listCatalog,
  previewCatalogSkill,
  type CatalogSourceId,
} from "../lib/skills/catalog-source";
import { __setGatewayForTests, readSkill } from "../lib/skills/store";
import { FakeBucket, skillMd } from "./helpers/fake-bucket";

/**
 * 0090 §7: public catalog discovery — GitHub git-trees grouping + raw
 * SKILL.md descriptions, preview and install — with fetch injected and
 * canned; the S3 side rides the fake bucket.
 */

let bucket: FakeBucket;
let calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  bucket = new FakeBucket();
  __setGatewayForTests(bucket);
  __resetCatalogCacheForTests();
  db().delete(gitCredentials).run();
  calls = [];
});

afterEach(() => {
  __setGatewayForTests(null);
});

type Blob = { path: string; type: string; size?: number };

/** The canned GitHub: one repo call, one recursive tree, raw files. */
function github(blobs: Blob[], raws: Record<string, string> = {}, sha = "main") {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url === "https://api.github.com/repos/anthropics/skills") {
      return new Response(JSON.stringify({ default_branch: sha }), { status: 200 });
    }
    if (url.startsWith("https://api.github.com/repos/anthropics/skills/git/trees/")) {
      return new Response(JSON.stringify({ tree: blobs }), { status: 200 });
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      const key = url.split(`/${sha}/`)[1];
      const body = raws[key];
      return body !== undefined
        ? new Response(body, { status: 200 })
        : new Response("not found", { status: 404 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

const blob = (path: string, size = 100): Blob => ({ path, type: "blob", size });
const raw = (description: string) => `---\nname: overridden\nauthor: anthropic\ndescription: ${description}\n---\n# Do it\n`;

const BASE_TREE: Blob[] = [
  blob("skills/README.md"), // directly under path/, not a skill
  blob("outside/doc.md"), // outside the source path
  blob("skills/pdf/SKILL.md", 40),
  blob("skills/pdf/reference.md", 60),
  blob("skills/notes/reference.md"), // no SKILL.md → not a skill
  blob("skills/Bad_Name/SKILL.md"), // id must match SKILL_ID
];

describe("listCatalog (0090 §7)", () => {
  it("groups the tree into skill folders — SKILL.md required, ids filtered, description parsed from raw", async () => {
    const fetchImpl = github(BASE_TREE, { "skills/pdf/SKILL.md": raw("Make PDFs") });
    const res = await listCatalog("anthropics", { fetchImpl });
    expect(res).toEqual({
      ok: true,
      truncated: false,
      skills: [{ id: "pdf", description: "Make PDFs", fileCount: 2, sizeBytes: 100 }],
    });
  });

  it("skips skills whose SKILL.md is unreadable or has no description", async () => {
    const res = await listCatalog("anthropics", {
      fetchImpl: github(BASE_TREE, { "skills/pdf/SKILL.md": "---\nother: x\n---\nbody" }),
    });
    expect(res).toEqual({ ok: true, truncated: false, skills: [] });
  });

  it("caps the list at 30 with truncated=true, alphabetical", async () => {
    const blobs: Blob[] = [];
    const raws: Record<string, string> = {};
    for (let i = 1; i <= 35; i++) {
      const id = `skill-${String(i).padStart(2, "0")}`;
      blobs.push(blob(`skills/${id}/SKILL.md`, 10));
      raws[`skills/${id}/SKILL.md`] = raw(`Skill ${i}`);
    }
    const res = await listCatalog("anthropics", { fetchImpl: github(blobs, raws) });
    expect(res.ok && res.skills.length).toBe(30);
    expect(res.ok && res.truncated).toBe(true);
    expect(res.ok && res.skills[0].id).toBe("skill-01");
    expect(res.ok && res.skills.at(-1)?.id).toBe("skill-30");
  });

  it("caches the listing for 10 minutes — a second call makes no fetches", async () => {
    const fetchImpl = github(BASE_TREE, { "skills/pdf/SKILL.md": raw("Make PDFs") });
    await listCatalog("anthropics", { fetchImpl });
    const before = calls.length;
    await listCatalog("anthropics", { fetchImpl });
    expect(calls.length).toBe(before);
  });

  it("authenticates api.github.com with the stored github credential, raw stays unauthenticated", async () => {
    db()
      .insert(gitCredentials)
      .values({ id: "gh", kind: "github", label: "chad", username: "chad", secret: "gh-token", baseUrl: null, createdAt: 0 })
      .onConflictDoNothing()
      .run();
    await listCatalog("anthropics", { fetchImpl: github(BASE_TREE, { "skills/pdf/SKILL.md": raw("Make PDFs") }) });
    const api = calls.filter((c) => c.url.startsWith("https://api.github.com/"));
    const rawCalls = calls.filter((c) => c.url.startsWith("https://raw.githubusercontent.com/"));
    expect(api.every((c) => ((c.init?.headers ?? {}) as Record<string, string>).authorization === "Bearer gh-token")).toBe(true);
    expect(rawCalls.every((c) => c.init?.headers === undefined)).toBe(true);
  });

  it("a failing tree call is a value", async () => {
    const fetchImpl = async () => new Response("nope", { status: 403 });
    await expect(listCatalog("anthropics", { fetchImpl })).resolves.toMatchObject({ ok: false, message: expect.stringContaining("403") });
  });
});

describe("preview + install (0090 §7)", () => {
  const TREE = [blob("skills/pdf/SKILL.md", 40), blob("skills/pdf/reference.md", 60)];

  it("preview returns the raw SKILL.md, files and the pinned sha", async () => {
    const fetchImpl = github(TREE, {
      "skills/pdf/SKILL.md": raw("Make PDFs"),
      "skills/pdf/reference.md": "ref body",
    });
    const res = await previewCatalogSkill("anthropics", "pdf", { fetchImpl });
    expect(res).toEqual({
      ok: true,
      skill: { id: "pdf", raw: raw("Make PDFs"), files: [{ path: "reference.md", content: "ref body" }], sha: "main" },
    });
  });

  it("an unknown skill is a value", async () => {
    const fetchImpl = github(TREE, { "skills/pdf/SKILL.md": raw("Make PDFs") });
    await expect(previewCatalogSkill("anthropics", "nope", { fetchImpl })).resolves.toMatchObject({ ok: false, code: "unknown-skill" });
  });

  it("file-count limits are caught from tree metadata before fetching", async () => {
    const many: Blob[] = [blob("skills/big/SKILL.md")];
    for (let i = 0; i < 20; i++) many.push(blob(`skills/big/f${i}.md`));
    await expect(previewCatalogSkill("anthropics", "big", { fetchImpl: github(many, {}) })).resolves.toMatchObject({
      ok: false,
      code: "invalid",
      message: expect.stringContaining("21 files"),
    });
  });

  it("per-file size limits are caught from tree metadata", async () => {
    const huge = [blob("skills/big/SKILL.md"), blob("skills/big/data.bin", 70 * 1024)];
    await expect(previewCatalogSkill("anthropics", "big", { fetchImpl: github(huge, {}) })).resolves.toMatchObject({
      ok: false,
      code: "invalid",
      message: expect.stringContaining("64 KiB"),
    });
  });

  it("install writes through saveSkill — name: normalized out, source provenance in the manifest", async () => {
    const res = await installCatalogSkill("anthropics" as CatalogSourceId, "pdf", {
      fetchImpl: github(TREE, { "skills/pdf/SKILL.md": raw("Make PDFs"), "skills/pdf/reference.md": "ref body" }),
    });
    expect(res).toMatchObject({ ok: true, id: "pdf", files: ["reference.md"] });
    const skill = await readSkill("pdf");
    expect(skill?.raw).toBe('---\nauthor: anthropic\ndescription: Make PDFs\n---\n# Do it\n');
    expect(skill?.source).toEqual({ repo: "anthropics/skills", ref: "main", path: "skills/pdf" });
    expect(skill?.author).toBe("catalog");
    expect(JSON.parse(bucket.objects.get("pdf/manifest.json")!).source).toEqual({
      repo: "anthropics/skills",
      ref: "main",
      path: "skills/pdf",
    });
  });

  it("a colliding local id is an honest error, nothing fetched or written", async () => {
    bucket.seed("pdf", skillMd("Local PDF skill"));
    const fetches = calls.length;
    const res = await installCatalogSkill("anthropics", "pdf", { fetchImpl: github(TREE, {}) });
    expect(res).toMatchObject({ ok: false, code: "id-exists" });
    expect(calls.length).toBe(fetches);
    expect((await readSkill("pdf"))?.description).toBe("Local PDF skill");
  });

  it("an unknown source is a value", async () => {
    await expect(listCatalog("nope", { fetchImpl: github([]) })).resolves.toMatchObject({ ok: false, message: expect.stringContaining("unknown catalog source") });
  });
});

describe("catalogDescription (folded YAML, live anthropics shapes)", () => {
  it("joins a folded > scalar's continuation lines", () => {
    const raw = "---\nname: x\ndescription: >\n  Stop and check this skill before finishing any reply.\n  Trigger on: how do I questions.\n---\n\nbody\n";
    expect(catalogDescription(raw)).toBe(
      "Stop and check this skill before finishing any reply. Trigger on: how do I questions.",
    );
  });

  it("keeps a plain single-line description untouched", () => {
    expect(catalogDescription("---\ndescription: plain line\n---\nbody")).toBe("plain line");
  });

  it("caps at 500 chars with an ellipsis", () => {
    const raw = `---\ndescription: >\n  ${"x".repeat(600)}\n---\nbody`;
    const out = catalogDescription(raw);
    expect(out.length).toBe(500);
    expect(out.endsWith("…")).toBe(true);
  });
});
