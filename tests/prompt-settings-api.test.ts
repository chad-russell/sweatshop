import { describe, expect, it } from "vitest";
import { readGitSkillDefault } from "../lib/skill-files";
import { GET, POST, PUT } from "../app/api/settings/agent/route";

/**
 * 0054 hardening (1)+(4): the Settings API route no longer casts
 * `request.json()`'s fields to typed shapes — it passes them straight
 * through to the store as `unknown`, and the store's own runtime
 * validation is what turns a malformed body into a value-shaped 400
 * rather than a thrown 500. These tests exercise the ROUTE (not just
 * the store directly) so a regression in either layer shows up here.
 */

const put = (body: unknown) =>
  PUT(new Request("http://x/api/settings/agent", { method: "PUT", body: JSON.stringify(body) }));
const get = (qs: string) => GET(new Request(`http://x/api/settings/agent?${qs}`));

describe("PUT /api/settings/agent: malformed bodies never 500", () => {
  it("rejects invalid JSON with a clean 400, not a thrown error", async () => {
    const res = await PUT(new Request("http://x/api/settings/agent", { method: "PUT", body: "not json {" }));
    expect(res.status).toBe(400);
  });

  it("rejects an unknown action", async () => {
    const res = await put({ action: "explode", target: { kind: "section", key: "base" }, expectedVersion: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects a target with an unknown field, and a target naming the wrong field for its kind", async () => {
    const r1 = await put({ action: "publish", target: { kind: "section", key: "base", evil: 1 }, patch: { body: "x" }, expectedVersion: 1 });
    expect(r1.status).toBe(400);
    expect((await r1.json()).code).toBe("invalid");

    const r2 = await put({ action: "publish", target: { kind: "section", key: "base", id: "nope" }, patch: { body: "x" }, expectedVersion: 1 });
    expect(r2.status).toBe(400);
  });

  it("rejects a patch with an unknown field", async () => {
    const res = await put({
      action: "publish",
      target: { kind: "skill", id: `apitest-${Date.now().toString(36)}` },
      patch: { body: "# Fixture", evilField: true },
      expectedVersion: 0,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).issues?.join(" ")).toContain("evilField");
  });

  it("rejects wrong-typed patch fields (body as a number, thread as a string, bogus status)", async () => {
    const id = `apitest-${Date.now().toString(36)}-types`;
    const r1 = await put({ action: "publish", target: { kind: "skill", id }, patch: { body: 123 }, expectedVersion: 0 });
    expect(r1.status).toBe(400);

    const r2 = await put({ action: "publish", target: { kind: "skill", id }, patch: { body: "# ok", thread: "yes" }, expectedVersion: 0 });
    expect(r2.status).toBe(400);

    const r3 = await put({ action: "publish", target: { kind: "skill", id }, patch: { body: "# ok", status: "sleeping" }, expectedVersion: 0 });
    expect(r3.status).toBe(400);
  });

  it("rejects a section patch carrying skill-only fields", async () => {
    const res = await put({ action: "publish", target: { kind: "section", key: "base" }, patch: { body: "x", status: "disabled" }, expectedVersion: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects a non-integer, negative, or oversized-type expectedVersion", async () => {
    for (const bad of [1.5, -1, "1", null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
      const res = await put({ action: "publish", target: { kind: "section", key: "base" }, patch: { body: "x" }, expectedVersion: bad });
      expect(res.status).toBe(400);
    }
  });

  it("rejects a non-string, oversized note", async () => {
    const r1 = await put({ action: "publish", target: { kind: "section", key: "base" }, patch: { body: "x" }, expectedVersion: 1, note: 42 });
    expect(r1.status).toBe(400);
    const r2 = await put({
      action: "publish",
      target: { kind: "section", key: "base" },
      patch: { body: "x" },
      expectedVersion: 1,
      note: "y".repeat(2001),
    });
    expect(r2.status).toBe(400);
  });

  it("rejects a non-integer restore version", async () => {
    const res = await put({ action: "restore", target: { kind: "section", key: "base" }, version: 0.5, expectedVersion: 1 });
    expect(res.status).toBe(400);
  });

  it("still accepts a well-formed publish and reports a real conflict as 409, not 400", async () => {
    const seeded = await get("action=detail&kind=section&key=base");
    const { current } = await seeded.json();
    const ok = await put({ action: "publish", target: { kind: "section", key: "base" }, patch: { body: "fine" }, expectedVersion: current.version });
    expect(ok.status).toBe(200);
    const stale = await put({ action: "publish", target: { kind: "section", key: "base" }, patch: { body: "stale" }, expectedVersion: current.version });
    expect(stale.status).toBe(409);
  });
});

describe("GET /api/settings/agent: shared parser, shipped metadata, traversal safety", () => {
  it("action=default for a shipped skill matches the shared git parser exactly, including description/thread", async () => {
    const res = await get("action=default&kind=skill&id=review");
    expect(res.status).toBe(200);
    const body = await res.json();
    const expected = readGitSkillDefault("review");
    expect(body).toMatchObject({ body: expected?.body, description: expected?.description, thread: expected?.thread });
  });

  it("action=default 404s for a non-shipped id, never touches the filesystem outside skills/", async () => {
    const res = await get(`action=default&kind=skill&id=${encodeURIComponent("not-a-real-skill")}`);
    expect(res.status).toBe(404);
  });

  it("rejects a path-traversal-shaped skill id as an invalid target, before any file read", async () => {
    const res = await get(`action=default&kind=skill&id=${encodeURIComponent("../../etc/passwd")}`);
    expect(res.status).toBe(400);
  });

  it("action=list and action=preview still work", async () => {
    const list = await get("action=list");
    expect(list.status).toBe(200);
    const { targets } = await list.json();
    expect(targets.some((t: { kind: string }) => t.kind === "section")).toBe(true);

    const preview = await get("action=preview");
    expect(preview.status).toBe(200);
    const { prompt } = await preview.json();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

const postPreview = (body: unknown) =>
  POST(new Request("http://x/api/settings/agent", { method: "POST", body: JSON.stringify(body) }));

describe("POST /api/settings/agent: draft preview", () => {
  it("replaces only the selected section even when saved blocks have identical text", async () => {
    const keys = ["base", "harness_steering"] as const;
    for (const key of keys) {
      const { current } = await (await get(`action=detail&kind=section&key=${key}`)).json();
      expect((await put({ action: "publish", target: { kind: "section", key }, patch: { body: "identical saved text" }, expectedVersion: current.version })).status).toBe(200);
    }
    const saved = (await (await get("action=preview")).json()).prompt as string;
    const response = await postPreview({ action: "preview", target: { kind: "section", key: "harness_steering" }, body: "only the harness draft" });
    expect(response.status).toBe(200);
    const { prompt } = await response.json();
    expect(prompt).toBe("identical saved text\n\nonly the harness draft\n\n" + saved.split("\n\n").slice(2).join("\n\n"));
    expect((await (await get("action=preview")).json()).prompt).toBe(saved);
  });

  it("handles an empty saved section without inserting into the wrong location or writing the draft", async () => {
    const key = "base";
    const { current } = await (await get(`action=detail&kind=section&key=${key}`)).json();
    expect((await put({ action: "publish", target: { kind: "section", key }, patch: { body: "" }, expectedVersion: current.version })).status).toBe(200);
    const before = (await (await get(`action=detail&kind=section&key=${key}`)).json()).current;
    const result = await postPreview({ action: "preview", target: { kind: "section", key }, body: "draft base" });
    expect(result.status).toBe(200);
    expect((await result.json()).prompt).toMatch(/^draft base\n\n/);
    expect((await (await get(`action=detail&kind=section&key=${key}`)).json()).current).toEqual(before);
  });

  it("rejects non-string, oversized, invalid targets and extra fields without writing", async () => {
    const target = { kind: "section", key: "base" };
    const before = (await (await get("action=detail&kind=section&key=base")).json()).current;
    for (const input of [
      { action: "preview", target, body: 123 },
      { action: "preview", target, body: "🦊".repeat(8193) },
      { action: "preview", target: { ...target, id: "wrong" }, body: "x" },
      { action: "preview", target: { kind: "skill", id: "review" }, body: "x" },
      { action: "preview", target, body: "x", patch: { status: "deleted" } },
    ]) expect((await postPreview(input)).status).toBe(400);
    expect((await (await get("action=detail&kind=section&key=base")).json()).current).toEqual(before);
  });
});
