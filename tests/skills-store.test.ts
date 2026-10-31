import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setGatewayForTests,
  deleteSkill,
  listAllSkills,
  listSkills,
  parseSkillMarkdown,
  pingStore,
  readSkill,
  readSkillFile,
  saveSkill,
  setSkillDisabled,
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

describe("pingStore (0090 §2)", () => {
  it("is a live list, not the cached listing — a warm cache still hits the bucket", async () => {
    bucket.seed("warm", skillMd("cached"));
    await status(); // warm the 60 s listing cache
    const before = bucket.lists;
    expect(await pingStore()).toEqual({ ok: true, detail: "connected" });
    expect(bucket.lists).toBeGreaterThan(before);
  });

  it("reports an unconfigured store without touching anything", async () => {
    __setGatewayForTests(null);
    expect(await pingStore()).toEqual({ ok: false, detail: "not configured (SKILLS_S3_* env)" });
  });

  it("a failing list is a value, and lands in lastError for the status card", async () => {
    bucket.failList = new Error("fetch boom");
    await expect(pingStore()).resolves.toEqual({ ok: false, detail: "fetch boom" });
    expect((await status()).lastError).toBe("fetch boom");
  });
});

describe("skills lifecycle (0090 §4/§5)", () => {
  it("listAllSkills includes disabled skills flagged; listSkills keeps excluding them", async () => {
    bucket.seed("pdf", skillMd("Make PDFs"));
    bucket.seed("old", skillMd("Legacy", "# Old\n\nKept.", "status: disabled\n"));
    expect(await listAllSkills()).toEqual([
      { id: "old", description: "Legacy", files: [], updatedAt: "2026-10-29T00:00:00.000Z", disabled: true },
      { id: "pdf", description: "Make PDFs", files: [], updatedAt: "2026-10-29T00:00:00.000Z", disabled: false },
    ]);
    expect((await listSkills()).map((s) => s.id)).toEqual(["pdf"]);
  });

  it("disabling adds the status line under the description and touches nothing else", async () => {
    const body = "# Runbook\n\nStep 1 has a `$&` in it and trailing lines\n\n\n";
    await saveSkill({ id: "pdf", body: `---\ndescription: Make PDFs\n---\n${body}`, files: [{ path: "ref.md", content: "keep" }], author: "agent" });
    const res = await setSkillDisabled("pdf", true);
    expect(res).toMatchObject({ ok: true, id: "pdf" });
    const after = await readSkill("pdf");
    expect(after?.disabled).toBe(true);
    expect(after?.body).toBe(body.trimEnd());
    expect(after?.fileContents).toEqual([{ path: "ref.md", content: "keep" }]);
    expect(after?.author).toBe("agent");
    expect(after?.raw).toBe(`---\ndescription: Make PDFs\nstatus: disabled\n---\n${body}`);
  });

  it("enabling removes the line, body byte-for-byte preserved", async () => {
    const raw = "---\ndescription: Make PDFs\nstatus: disabled\n---\n# Runbook\n\nDo it.\n";
    bucket.seed("pdf", raw);
    expect(await setSkillDisabled("pdf", false)).toMatchObject({ ok: true });
    const after = await readSkill("pdf");
    expect(after?.disabled).toBe(false);
    expect(after?.raw).toBe("---\ndescription: Make PDFs\n---\n# Runbook\n\nDo it.\n");
  });

  it("an already-correct status is a no-op success — nothing written", async () => {
    bucket.seed("pdf", skillMd("Make PDFs"));
    const puts = bucket.puts.length;
    expect(await setSkillDisabled("pdf", false)).toEqual({ ok: true, id: "pdf" });
    expect(bucket.puts.length).toBe(puts);
  });

  it("unknown ids and an unconfigured store are values", async () => {
    expect(await setSkillDisabled("nope", true)).toMatchObject({ ok: false, code: "unknown-skill" });
    expect(await deleteSkill("nope")).toMatchObject({ ok: false, code: "unknown-skill" });
    expect(await setSkillDisabled("Bad", true)).toMatchObject({ ok: false, code: "invalid" });
    __setGatewayForTests(null);
    expect(await setSkillDisabled("pdf", true)).toMatchObject({ ok: false, code: "unconfigured" });
    expect(await deleteSkill("pdf")).toMatchObject({ ok: false, code: "unconfigured" });
  });

  it("delete removes the manifest FIRST, then the files — a torn delete never half-loads", async () => {
    bucket.seed("pdf", skillMd("Make PDFs"), { "ref.md": "r", "img.txt": "i" });
    expect(await deleteSkill("pdf")).toEqual({ ok: true, id: "pdf" });
    expect(bucket.deletes[0]).toBe("pdf/manifest.json");
    expect([...bucket.deletes.slice(1)].sort()).toEqual(["pdf/SKILL.md", "pdf/img.txt", "pdf/ref.md"]);
    expect(await readSkill("pdf")).toBeNull();
    expect(await listAllSkills()).toEqual([]);
  });

  it("a delete failing after the manifest is a store-error, and the skill never half-loads", async () => {
    bucket.seed("pdf", skillMd("Make PDFs"), { "ref.md": "r" });
    bucket.failDeleteOn = "ref.md";
    expect(await deleteSkill("pdf")).toMatchObject({ ok: false, code: "store-error" });
    expect(bucket.objects.has("pdf/manifest.json")).toBe(false); // gone FIRST
    expect(await listAllSkills()).toEqual([]);
  });
});
