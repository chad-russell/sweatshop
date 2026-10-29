import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setGatewayForTests,
  listSkills,
  parseSkillMarkdown,
  readSkill,
  readSkillFile,
  saveSkill,
  status,
  validateSkillInput,
} from "../lib/skills/store";
import { FakeBucket, skillMd } from "./helpers/fake-bucket";

/**
 * 0088: the S3-backed skills store against a fake bucket (the S3Gateway
 * seam) — listing/grouping, front matter, validation, cache TTL, the
 * torn-write guard, and errors as values.
 */

let bucket: FakeBucket;

beforeEach(() => {
  bucket = new FakeBucket();
  __setGatewayForTests(bucket);
});

afterEach(() => {
  __setGatewayForTests(null);
  vi.useRealTimers();
  for (const key of Object.keys(process.env)) if (key.startsWith("SKILLS_S3_")) delete process.env[key];
});

describe("parseSkillMarkdown", () => {
  it("reads description and status from front matter and strips it from the body", () => {
    expect(parseSkillMarkdown('---\ndescription: "Ship PRs"\nstatus: disabled\n---\n# Ship\n\nGo.\n')).toEqual({
      description: "Ship PRs",
      disabled: true,
      body: "# Ship\n\nGo.",
    });
  });

  it("a file with no front matter has no description and is its own body", () => {
    expect(parseSkillMarkdown("# Bare")).toEqual({ description: "", disabled: false, body: "# Bare" });
  });
});

describe("listing", () => {
  it("groups objects by first path segment and sorts by id", async () => {
    bucket.seed("zeta", skillMd("Last one"));
    bucket.seed("alpha", skillMd("First one"), { "reference.md": "ref", "examples/a.md": "ex" });
    const skills = await listSkills();
    expect(skills.map((s) => s.id)).toEqual(["alpha", "zeta"]);
    expect(skills[0]).toMatchObject({ description: "First one", files: ["examples/a.md", "reference.md"] });
  });

  it("skips bad ids, loose root objects, and disabled skills", async () => {
    bucket.seed("Bad_Id", skillMd("nope"));
    bucket.seed("ok", skillMd("fine"));
    bucket.seed("off", skillMd("hidden", "# x", "status: disabled\n"));
    bucket.objects.set("loose.md", "x");
    expect((await listSkills()).map((s) => s.id)).toEqual(["ok"]);
    expect(await readSkill("off")).toMatchObject({ disabled: true });
  });

  it("honors the prefix", async () => {
    __setGatewayForTests(bucket, "team/skills");
    bucket.seed("mine", skillMd("scoped"), {}, "team/skills/");
    bucket.seed("other", skillMd("outside"), {}, "elsewhere/");
    expect((await listSkills()).map((s) => s.id)).toEqual(["mine"]);
  });

  it("caches the listing for 60s, then refreshes", async () => {
    vi.useFakeTimers();
    bucket.seed("a", skillMd("one"));
    await listSkills();
    bucket.seed("b", skillMd("two"));
    vi.advanceTimersByTime(59_000);
    expect((await listSkills()).map((s) => s.id)).toEqual(["a"]);
    expect(bucket.lists).toBe(1);
    vi.advanceTimersByTime(2_000);
    expect((await listSkills()).map((s) => s.id)).toEqual(["a", "b"]);
    expect(bucket.lists).toBe(2);
  });

  it("skips a skill with a missing manifest (torn write)", async () => {
    bucket.seed("torn", skillMd("half"));
    bucket.objects.delete("torn/manifest.json");
    bucket.seed("whole", skillMd("fine"));
    expect((await listSkills()).map((s) => s.id)).toEqual(["whole"]);
  });

  it("skips a skill whose manifest names a missing file or a mismatched size", async () => {
    bucket.seed("missing", skillMd("x"), { "ref.md": "abc" });
    bucket.objects.delete("missing/ref.md");
    bucket.seed("resized", skillMd("x"), { "ref.md": "abc" });
    bucket.objects.set("resized/ref.md", "abcdef");
    bucket.seed("fine", skillMd("x"));
    expect((await listSkills()).map((s) => s.id)).toEqual(["fine"]);
  });

  it("a malformed manifest only drops its own skill", async () => {
    bucket.seed("bad", skillMd("x"));
    bucket.objects.set("bad/manifest.json", "{nope");
    bucket.seed("good", skillMd("y"));
    expect((await listSkills()).map((s) => s.id)).toEqual(["good"]);
  });
});

describe("reads", () => {
  it("readSkill returns the body without front matter, the raw text, and files", async () => {
    bucket.seed("ship", skillMd("Ship it", "# Ship\n\nGo."), { "ref/codes.md": "codes" });
    const skill = await readSkill("ship");
    expect(skill).toMatchObject({ id: "ship", description: "Ship it", body: "# Ship\n\nGo.", files: ["ref/codes.md"] });
    expect(skill?.raw).toContain("description: Ship it");
    expect(await readSkillFile("ship", "ref/codes.md")).toBe("codes");
    expect(await readSkillFile("ship", "nope.md")).toBeNull();
  });

  it("unknown or malformed ids read as null", async () => {
    expect(await readSkill("ghost")).toBeNull();
    expect(await readSkill("../etc")).toBeNull();
  });

  it("bodies are cached: a second read does not re-fetch the files", async () => {
    bucket.seed("a", skillMd("one"));
    const spy = vi.spyOn(bucket, "get");
    await readSkill("a");
    const after = spy.mock.calls.length;
    await readSkill("a");
    expect(spy.mock.calls.length).toBe(after);
  });
});

describe("store errors are values", () => {
  it("an unreachable store reads as an empty catalog and surfaces in status()", async () => {
    bucket.failList = new Error("connect ECONNREFUSED");
    expect(await listSkills()).toEqual([]);
    expect(await readSkill("a")).toBeNull();
    expect(await status()).toEqual({ configured: true, skillCount: 0, lastError: "connect ECONNREFUSED" });
  });

  it("recovers after the error TTL and clears lastError", async () => {
    vi.useFakeTimers();
    bucket.seed("a", skillMd("one"));
    bucket.failList = new Error("down");
    expect(await listSkills()).toEqual([]);
    bucket.failList = null;
    vi.advanceTimersByTime(11_000);
    expect((await listSkills()).map((s) => s.id)).toEqual(["a"]);
    expect(await status()).toEqual({ configured: true, skillCount: 1 });
  });

  it("unconfigured (no env, no gateway) is an empty catalog, not an error", async () => {
    __setGatewayForTests(null);
    expect(await listSkills()).toEqual([]);
    expect(await status()).toEqual({ configured: false });
    expect(await saveSkill({ id: "a", body: skillMd("x") })).toMatchObject({ ok: false, code: "unconfigured" });
  });
});

describe("validateSkillInput", () => {
  const ok = { id: "good-id", body: skillMd("When to use it") };

  it("accepts a well-formed skill", () => {
    expect(validateSkillInput({ ...ok, files: [{ path: "examples/a.md", content: "x" }] })).toEqual([]);
  });

  it.each(["Upper", "1abc", "a_b", "", "a".repeat(42)])("rejects id %j", (id) => {
    expect(validateSkillInput({ ...ok, id }).join()).toMatch(/skill id/);
  });

  it("requires a description and a body", () => {
    expect(validateSkillInput({ id: "a", body: "# no front matter" }).join()).toMatch(/description/);
    expect(validateSkillInput({ id: "a", body: "---\ndescription: x\n---\n" }).join()).toMatch(/no body/);
  });

  it.each(["../x.md", "/abs.md", "a/../b.md", "a//b.md", "a\\b.md", "./a.md", "SKILL.md", "manifest.json"])(
    "rejects file path %j",
    (path) => {
      expect(validateSkillInput({ ...ok, files: [{ path, content: "x" }] })).not.toEqual([]);
    },
  );

  it("rejects duplicates, too many files, oversize files and oversize skills", () => {
    expect(validateSkillInput({ ...ok, files: [{ path: "a.md", content: "" }, { path: "a.md", content: "" }] }).join()).toMatch(/duplicate/);
    const many = Array.from({ length: 16 }, (_, i) => ({ path: `f${i}.md`, content: "" }));
    expect(validateSkillInput({ ...ok, files: many }).join()).toMatch(/at most 16/);
    expect(validateSkillInput({ ...ok, files: [{ path: "big.md", content: "x".repeat(64 * 1024 + 1) }] }).join()).toMatch(/64 KiB/);
    const heavy = Array.from({ length: 5 }, (_, i) => ({ path: `h${i}.md`, content: "x".repeat(60 * 1024) }));
    expect(validateSkillInput({ ...ok, files: heavy }).join()).toMatch(/256 KiB in total/);
  });
});

describe("saveSkill", () => {
  it("PUTs every file first and the manifest LAST, then the skill is readable", async () => {
    const res = await saveSkill({
      id: "fresh",
      body: skillMd("Fresh skill"),
      files: [{ path: "ref.md", content: "r" }],
      author: "agent",
    });
    expect(res).toEqual({ ok: true, id: "fresh", files: ["ref.md"] });
    expect(bucket.puts).toEqual(["fresh/SKILL.md", "fresh/ref.md", "fresh/manifest.json"]);
    expect(JSON.parse(bucket.objects.get("fresh/manifest.json")!)).toMatchObject({
      files: ["SKILL.md", "ref.md"],
      author: "agent",
    });
    expect((await listSkills()).map((s) => s.id)).toEqual(["fresh"]);
  });

  it("an edit is visible immediately (cache invalidated), replacing the file set", async () => {
    bucket.seed("a", skillMd("old"), { "gone.md": "x" });
    expect((await listSkills())[0]?.description).toBe("old");
    await saveSkill({ id: "a", body: skillMd("new") });
    const skill = await readSkill("a");
    expect(skill).toMatchObject({ description: "new", files: [] });
  });

  it("invalid input writes nothing", async () => {
    const res = await saveSkill({ id: "Bad", body: "x" });
    expect(res).toMatchObject({ ok: false, code: "invalid" });
    expect(bucket.puts).toEqual([]);
  });

  it("a failure mid-write leaves no manifest, so the torn skill never loads", async () => {
    bucket.failPutAfter = 1;
    const res = await saveSkill({ id: "torn", body: skillMd("x"), files: [{ path: "r.md", content: "r" }] });
    expect(res).toMatchObject({ ok: false, code: "store-error" });
    expect(bucket.objects.has("torn/manifest.json")).toBe(false);
    expect(await listSkills()).toEqual([]);
  });
});
