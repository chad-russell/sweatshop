import { afterEach, describe, expect, it } from "vitest";
import { GET } from "../app/api/x/prs/route";
import { db } from "../db";
import { gitCredentials } from "../db/schema";
import { prWatchId as prWatchIdOf } from "../db/pr-watches";

/**
 * 0052 — GET /api/x/prs: the batched live-PR-state route. Credentials
 * seed the temp db; the hosts' outgoing API calls hit a stubbed global
 * fetch (the route resolves real credentials through the real seam).
 */
db()
  .insert(gitCredentials)
  .values([
    { id: "prs-gh", kind: "github", label: "gh", username: "chad", secret: "tok", baseUrl: null, createdAt: 0 },
    { id: "prs-fj", kind: "forgejo", label: "fj", username: "glen", secret: "tok", baseUrl: "https://git.example.com", createdAt: 0 },
  ])
  .onConflictDoNothing()
  .run();

const GH_URL = "https://github.com/o/r/pull/7";
const FJ_URL = "https://git.example.com/o/r/pulls/2";

const realFetch = globalThis.fetch;
let calls: string[] = [];

/** Stub the hosts' outgoing API calls; `body` may vary by URL. */
function stubFetchJson(status: number, body: unknown) {
  calls = [];
  globalThis.fetch = (async (url: unknown) => {
    const target = String(url);
    calls.push(target);
    const payload =
      typeof body === "function" ? (body as (url: string) => unknown)(target) : body;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const request = (urls: string[]) =>
  new Request(`http://x/api/x/prs?${urls.map((u) => `url=${encodeURIComponent(u)}`).join("&")}`);

describe("0052 GET /api/x/prs", () => {
  it("answers a batch keyed by the exact input URLs", async () => {
    // Each host answers in its own shape (live-verified 0053 review):
    // both carry a merged boolean + merged_at timestamp.
    stubFetchJson(200, (url: string) =>
      url.startsWith("https://api.github.com")
        ? { state: "closed", merged: true, merged_at: "2026-10-01T10:00:00Z" }
        : { state: "open", merged: true, merged_at: "2026-10-01T10:00:00Z" },
    );
    const res = await GET(request([GH_URL, FJ_URL]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      [GH_URL]: { state: "merged", mergedAt: "2026-10-01T10:00:00Z" },
      [FJ_URL]: { state: "merged", mergedAt: "2026-10-01T10:00:00Z" },
    });
    // Each URL hit its own host's API with the parsed owner/repo/number.
    expect(calls).toEqual([
      "https://api.github.com/repos/o/r/pulls/7",
      "https://git.example.com/api/v1/repos/o/r/pulls/2",
    ]);
  });

  it("maps a host error, an unknown host, and a malformed URL to null — never 500", async () => {
    stubFetchJson(500, { message: "boom" });
    const res = await GET(request([GH_URL, "https://unknown.example.com/o/r/pull/1", "not a url"]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      [GH_URL]: null, // host down → unknown
      "https://unknown.example.com/o/r/pull/1": null, // no credential covers it
      "not a url": null, // unparseable
    });
  });

  it("caps at 10 URLs per request, silently dropping the rest", async () => {
    stubFetchJson(200, { state: "open", merged: false });
    const urls = Array.from({ length: 12 }, (_, i) => `https://github.com/o/r${i}/pull/${i + 1}`);
    const res = await GET(request(urls));
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toHaveLength(10);
    expect(calls).toHaveLength(10);
    expect(body[urls[10]]).toBeUndefined(); // dropped entirely, never asked
  });

  it("answers a settled watch from the row — no host fetch (0084)", async () => {
    // If asked, the host would say open; the settled row must win.
    stubFetchJson(200, { state: "open", merged: false });
    const { ensureConversation } = await import("../db/chat");
    const { settlePrWatch, upsertPrWatch } = await import("../db/pr-watches");
    ensureConversation(db(), "c_prw_route", null);
    upsertPrWatch(db(), {
      conversationId: "c_prw_route",
      baseUrl: "https://github.com",
      owner: "o",
      repo: "r",
      number: 7,
    });
    settlePrWatch(db(), prWatchIdOf("https://github.com", "o", "r", 7), "merged", 1_760_000_000_000);
    const res = await GET(request([GH_URL]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      [GH_URL]: { state: "merged", mergedAt: new Date(1_760_000_000_000).toISOString() },
    });
    expect(calls).toHaveLength(0);
  });

  it("still asks the host for an OPEN watch — only settled rows answer locally (0084)", async () => {
    stubFetchJson(200, { state: "open", merged: false });
    const { ensureConversation } = await import("../db/chat");
    const { upsertPrWatch } = await import("../db/pr-watches");
    ensureConversation(db(), "c_prw_route_open", null);
    upsertPrWatch(db(), {
      conversationId: "c_prw_route_open",
      baseUrl: "https://git.example.com",
      owner: "o",
      repo: "r",
      number: 2,
    });
    const res = await GET(request([FJ_URL]));
    expect(await res.json()).toEqual({ [FJ_URL]: { state: "open" } });
    expect(calls).toHaveLength(1);
  });
});
