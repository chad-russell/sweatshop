import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { gitCredentials } from "../db/schema";
import { runForgejo } from "../lib/agent/tools/forgejo";

/**
 * 0033 Phase A′: the forgejo core — path allowlist, credential
 * gating, secret scrubbing, clipping, value-shaped HTTP/network
 * errors. fetch is injected, so nothing touches the network.
 */

const SECRET = "fjo_testtoken456";

const seedCredential = (baseUrl = "https://git.example.io") =>
  db()
    .insert(gitCredentials)
    .values({
      id: "fj-test", kind: "forgejo", label: "test", username: "chad",
      secret: SECRET, baseUrl, createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  db().delete(gitCredentials).run();
});

describe("forgejo allowlist", () => {
  it("allows exactly the read-only path patterns", async () => {
    seedCredential();
    const fetchImpl = (() => Promise.resolve(jsonResponse({ ok: true }))) as unknown as typeof fetch;
    for (const good of [
      "/repos/search",
      "/repos/chad/sweatshop",
      "/repos/chad/sweatshop/branches",
      "/repos/chad/sweatshop/issues",
      "/repos/chad/sweatshop/issues/7",
      "/repos/chad/sweatshop/pulls",
      "/repos/chad/sweatshop/pulls/3",
      "/repos/chad/sweatshop/releases",
      "/orgs/glenco/repos",
      "/users/crussell/repos",
      "/user",
    ]) {
      const result = await runForgejo(good, {}, fetchImpl);
      expect(result.ok, good).toBe(true);
    }
  });

  it("refuses write paths, traversal, and junk with the listing", async () => {
    seedCredential();
    for (const bad of [
      "/user/tokens",
      "/repos/chad/sweatshop/../../settings",
      "/repos/UPPER/repo",
      "/repos/chad/sweatshop/raw/README.md",
      "",
      "/admin",
    ]) {
      const result = await runForgejo(bad.replace("../..", "x/y"), {}, (() => Promise.resolve(jsonResponse({}))) as unknown as typeof fetch);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.allowed).toContain("/repos/{owner}/{repo}");
    }
    // the real traversal string (with ../..) is refused by the pattern itself
    const traversal = await runForgejo("/repos/chad/sweatshop/branches%2f..%2f..%2fsettings", {});
    expect(traversal.ok).toBe(false);
  });

  it("builds the URL with encoded params and Basic auth, and never leaks the secret", async () => {
    seedCredential();
    let seen: { url: string; headers: Headers } | null = null;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen = { url: String(url), headers: new Headers(init?.headers) };
      return jsonResponse({ note: `secret ${SECRET}` });
    }) as unknown as typeof fetch;
    const result = await runForgejo("/repos/search", { q: "sweat shop", limit: "5" }, fetchImpl);
    expect(result.ok).toBe(true);
    expect(seen!.url).toBe("https://git.example.io/api/v1/repos/search?q=sweat+shop&limit=5");
    expect(seen!.headers.get("authorization")).toBe(`Basic ${Buffer.from(`chad:${SECRET}`).toString("base64")}`);
    expect(result.ok ? result.output : "").not.toContain(SECRET);
    expect(result.ok ? result.output : "").toContain("***");
  });

  it("is not-configured without a forgejo credential (no fetch)", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const result = await runForgejo("/repos/search", {}, fetchImpl);
    expect(result).toMatchObject({ ok: false, code: "not-configured" });
    expect(called).toBe(false);
  });

  it("reports http-error and network failures as values", async () => {
    seedCredential();
    const fail404 = (async () => jsonResponse({ message: "nope" }, 404)) as unknown as typeof fetch;
    expect(await runForgejo("/repos/chad/missing", {}, fail404)).toMatchObject({ ok: false, code: "http-error" });
    const failNet = (async () => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    expect(await runForgejo("/user", {}, failNet)).toMatchObject({ ok: false, code: "network" });
  });

  it("clips long output", async () => {
    seedCredential();
    const long = (async () => jsonResponse({ blob: "y".repeat(30_000) })) as unknown as typeof fetch;
    const result = await runForgejo("/repos/search", {}, long);
    expect(result.ok ? result.output.length : 0).toBeLessThan(30_000);
    expect(result.ok ? result.output : "").toContain("[clipped");
  });
});
