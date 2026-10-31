import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { gitCredentials } from "../db/schema";
import {
  __resetCatalogCacheForTests,
  catalogDescription,
  installCatalogSkill,
  listCatalog,
  previewCatalogSkill,
  previewSearchSkill,
  installSearchSkill,
  searchCatalogs,
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

describe("SOURCES (0091 §1)", () => {
  it("holds the three curated repos with verified paths", async () => {
    const { SOURCES } = await import("../lib/skills/sources");
    expect(SOURCES.map((s) => [s.id, `${s.owner}/${s.repo}`, s.path, s.label])).toEqual([
      ["anthropics", "anthropics/skills", "skills", "anthropics/skills"],
      ["superpowers", "obra/superpowers", "skills", "obra/superpowers"],
      ["openclaw", "openclaw/openclaw", "skills", "openclaw/openclaw"],
    ]);
  });
});

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

  it("browses a newly added source the same way — per-source cache", async () => {
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url === "https://api.github.com/repos/obra/superpowers") {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (url.startsWith("https://api.github.com/repos/obra/superpowers/git/trees/")) {
        return new Response(
          JSON.stringify({ tree: [blob("skills/brainstorm/SKILL.md", 50), blob("skills/.agents/SKILL.md", 10)] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/skills/brainstorm/SKILL.md")) return new Response(raw("Brainstorm better"), { status: 200 });
      return new Response("nf", { status: 404 });
    };
    const res = await listCatalog("superpowers", { fetchImpl });
    expect(res).toEqual({
      ok: true,
      truncated: false,
      skills: [{ id: "brainstorm", description: "Brainstorm better", fileCount: 1, sizeBytes: 50 }],
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

describe("searchCatalogs (0091 §1)", () => {
  const row = (over: Record<string, unknown>) => ({
    name: "Nano PDF",
    author: "openclaw",
    description: "Tiny PDF tool",
    stars: 42,
    ...over,
  });
  const page = (skills: Record<string, unknown>[]) =>
    new Response(JSON.stringify({ success: true, data: { skills } }), { status: 200 });
  let calls: string[] = [];
  const skillsmp = (p1: Record<string, unknown>[], p2?: Record<string, unknown>[], failPage2 = false) =>
    async (url: string): Promise<Response> => {
      calls.push(url);
      if (url.includes("page=1")) return page(p1);
      if (url.includes("page=2")) {
        if (failPage2) return new Response("boom", { status: 503 });
        return page(p2 ?? []);
      }
      throw new Error(`unexpected fetch ${url}`);
    };

  beforeEach(() => {
    calls = [];
  });

  it("merges two pages, parses githubUrl into owner/repo/ref/path", async () => {
    const res = await searchCatalogs("pdf", {
      fetchImpl: skillsmp(
        [
          row({ githubUrl: "https://github.com/openclaw/openclaw/tree/main/skills/nano-pdf" }),
          row({ githubUrl: "https://github.com/mattpocock/skills/tree/v1/docs/pdf-tools" }),
        ],
        [row({ name: "Other PDF", githubUrl: "https://github.com/openclaw/openclaw/blob/main/skills/pdf-merge" })],
      ),
    });
    expect(res.ok && res.results).toEqual([
      { id: "nano-pdf", name: "Nano PDF", author: "openclaw", description: "Tiny PDF tool", stars: 42, repo: "openclaw/openclaw", path: "skills/nano-pdf", ref: "main" },
      { id: "pdf-tools", name: "Nano PDF", author: "openclaw", description: "Tiny PDF tool", stars: 42, repo: "mattpocock/skills", path: "docs/pdf-tools", ref: "v1" },
      { id: "pdf-merge", name: "Other PDF", author: "openclaw", description: "Tiny PDF tool", stars: 42, repo: "openclaw/openclaw", path: "skills/pdf-merge", ref: "main" },
    ]);
  });

  it("skips unmatched githubUrls and invalid folder ids; dedupes repo+path", async () => {
    const res = await searchCatalogs("pdf", {
      fetchImpl: skillsmp([
        row({ githubUrl: "https://github.com/openclaw/openclaw" }), // repo root
        row({ githubUrl: "https://gitlab.com/x/y/tree/main/skills/pdf" }), // not github
        row({ githubUrl: "https://github.com/a/b/tree/main/skills/My.Skill" }), // bad id
        row({ githubUrl: "https://github.com/a/b/tree/main/skills/pdf/SKILL.md" }), // file link
        row({ githubUrl: "https://github.com/a/b/tree/main/skills/pdf/" }), // trailing slash, dup target
      ]),
    });
    expect(res.ok && res.results).toEqual([
      { id: "pdf", name: "Nano PDF", author: "openclaw", description: "Tiny PDF tool", stars: 42, repo: "a/b", path: "skills/pdf", ref: "main" },
    ]);
  });

  it("caches per query for 5 minutes — a second call makes no fetches; case-insensitive key", async () => {
    await searchCatalogs("PDF ", { fetchImpl: skillsmp([row({ githubUrl: "https://github.com/a/b/tree/main/skills/pdf" })]) });
    const before = calls.length;
    await searchCatalogs("pdf", { fetchImpl: skillsmp([row({ githubUrl: "https://github.com/a/b/tree/main/skills/pdf" })]) });
    expect(calls.length).toBe(before);
  });

  it("one failed page keeps the other's rows; both failing is a value", async () => {
    const partial = await searchCatalogs("pdf", {
      fetchImpl: skillsmp([row({ githubUrl: "https://github.com/a/b/tree/main/skills/pdf" })], [], true),
    });
    expect(partial.ok && partial.results.length).toBe(1);

    const dead = async () => new Response("down", { status: 503 });
    await expect(searchCatalogs("gone", { fetchImpl: dead })).resolves.toMatchObject({ ok: false, message: expect.stringContaining("503") });
  });

  it("an empty query is a value", async () => {
    await expect(searchCatalogs("   ")).resolves.toMatchObject({ ok: false, message: "empty query" });
  });
});

describe("search-origin preview + install (0091 §1)", () => {
  const SHA = "abc123def4567890abcd";
  /** openclaw/openclaw at a pinned head sha — the search-origin target. */
  const fetchImpl = async (url: string): Promise<Response> => {
    if (url === "https://api.github.com/repos/openclaw/openclaw") {
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }
    if (url === "https://api.github.com/repos/openclaw/openclaw/commits/main") {
      return new Response(JSON.stringify({ sha: SHA }), { status: 200 });
    }
    if (url.startsWith(`https://api.github.com/repos/openclaw/openclaw/git/trees/${SHA}`)) {
      return new Response(
        JSON.stringify({ tree: [blob("skills/nano-pdf/SKILL.md", 30), blob("skills/nano-pdf/guide.md", 20), blob("skills/other/SKILL.md", 10)] }),
        { status: 200 },
      );
    }
    if (url === `https://raw.githubusercontent.com/openclaw/openclaw/${SHA}/skills/nano-pdf/SKILL.md`) {
      return new Response(raw("Nano PDFs"), { status: 200 });
    }
    if (url === `https://raw.githubusercontent.com/openclaw/openclaw/${SHA}/skills/nano-pdf/guide.md`) {
      return new Response("the guide", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  it("previews at the repo's CURRENT head sha — never the branch name", async () => {
    const res = await previewSearchSkill("openclaw/openclaw", "skills/nano-pdf", { fetchImpl });
    expect(res).toEqual({
      ok: true,
      skill: { id: "nano-pdf", raw: raw("Nano PDFs"), files: [{ path: "guide.md", content: "the guide" }], sha: SHA },
    });
  });

  it("installs with provenance pinned to the sha, author skillsmp, name: stripped", async () => {
    const res = await installSearchSkill("openclaw/openclaw", "skills/nano-pdf", { fetchImpl });
    expect(res).toMatchObject({ ok: true, id: "nano-pdf", files: ["guide.md"] });
    const skill = await readSkill("nano-pdf");
    expect(skill?.raw).toBe('---\nauthor: anthropic\ndescription: Nano PDFs\n---\n# Do it\n');
    expect(skill?.author).toBe("skillsmp");
    expect(skill?.source).toEqual({ repo: "openclaw/openclaw", ref: SHA, path: "skills/nano-pdf" });
  });

  it("a colliding local id is an honest error; bad shapes and missing SKILL.md are values", async () => {
    bucket.seed("nano-pdf", skillMd("Local nano-pdf"));
    await expect(installSearchSkill("openclaw/openclaw", "skills/nano-pdf", { fetchImpl })).resolves.toMatchObject({ ok: false, code: "id-exists" });

    await expect(previewSearchSkill("openclaw", "skills/x", { fetchImpl })).resolves.toMatchObject({ ok: false, code: "invalid", message: expect.stringContaining("owner/repo") });
    await expect(previewSearchSkill("openclaw/openclaw", "../etc", { fetchImpl })).resolves.toMatchObject({ ok: false, code: "invalid" });
    await expect(previewSearchSkill("openclaw/openclaw", "skills/no-skill-md", { fetchImpl })).resolves.toMatchObject({
      ok: false,
      code: "unknown-skill",
      message: expect.stringContaining("No SKILL.md"),
    });
  });
});

describe("parseSkillOrigin (0091 §1)", () => {
  it("defaults to the anthropics source; accepts the other sources", async () => {
    const { parseSkillOrigin } = await import("../lib/skills/catalog-source");
    expect(parseSkillOrigin({})).toEqual({ ok: true, value: { origin: "source", source: "anthropics" } });
    expect(parseSkillOrigin({ source: "superpowers" })).toEqual({ ok: true, value: { origin: "source", source: "superpowers" } });
    expect(parseSkillOrigin({ source: "nope" })).toEqual({ ok: false, message: 'unknown catalog source "nope"' });
  });

  it("origin=search requires repo and path shapes", async () => {
    const { parseSkillOrigin } = await import("../lib/skills/catalog-source");
    expect(parseSkillOrigin({ origin: "search", repo: "openclaw/openclaw", path: "skills/nano-pdf" })).toEqual({
      ok: true,
      value: { origin: "search", repo: "openclaw/openclaw", path: "skills/nano-pdf" },
    });
    expect(parseSkillOrigin({ origin: "search", path: "skills/nano-pdf" })).toEqual({ ok: false, message: expect.stringContaining("repo") });
    expect(parseSkillOrigin({ origin: "search", repo: "openclaw/openclaw" })).toEqual({ ok: false, message: expect.stringContaining("path") });
    expect(parseSkillOrigin({ origin: "weird" })).toEqual({ ok: false, message: expect.stringContaining("origin") });
  });
});
