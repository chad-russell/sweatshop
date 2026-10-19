import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { gitCredentials, projectRepos, projects } from "../db/schema";
import type { PRSummary } from "../lib/git-hosts";
import { loadPRDashboard, type ListPRsFn } from "../lib/prs/dashboard";

/**
 * 0053 — the dashboard loader against a seeded temp db with the host
 * seam injected: assembly only (author filter, dedupe, ordering,
 * failed-repo isolation), never a real API call.
 */
const tdb = openDb(process.env.SWEATSHOP_DB!);

// One forgejo credential (git.example.com) + one github credential; the
// loader filters each repo's PRs by that repo's own credential.
for (const p of [{ id: "prsdash-a", name: "A", createdAt: 0 }, { id: "prsdash-b", name: "B", createdAt: 0 }]) {
  tdb.insert(projects).values(p).onConflictDoNothing().run();
}
for (const r of [
  { id: "prsdash-a/shop", projectId: "prsdash-a", url: "https://git.example.com/chad/shop", name: "shop", createdAt: 0 },
  // same repo in a second project — its PRs dedupe by canonical URL
  { id: "prsdash-b/shop", projectId: "prsdash-b", url: "https://git.example.com/chad/shop.git", name: "shop", createdAt: 0 },
  { id: "prsdash-a/web", projectId: "prsdash-a", url: "https://github.com/chad/web", name: "web", createdAt: 0 },
  { id: "prsdash-a/unknown", projectId: "prsdash-a", url: "https://unknown.example.com/o/r", name: "unknown", createdAt: 0 },
  { id: "prsdash-a/down", projectId: "prsdash-a", url: "https://git.example.com/chad/down", name: "down", createdAt: 0 },
]) {
  tdb.insert(projectRepos).values(r).onConflictDoNothing().run();
}
for (const c of [
  { id: "prs-fj", kind: "forgejo", label: "fj", username: "chad", secret: "tok", baseUrl: "https://git.example.com", createdAt: 0 },
  { id: "prs-gh", kind: "github", label: "gh", username: "ChadGH", secret: "tok", baseUrl: null, createdAt: 0 },
]) {
  tdb.insert(gitCredentials).values(c).onConflictDoNothing().run();
}

/** A PR summary with defaults; only the identifying bits need spelling out. */
const pr = (over: Partial<PRSummary> & Pick<PRSummary, "number" | "url">): PRSummary => ({
  title: `PR ${over.number}`,
  state: "open",
  head: "feat/x",
  author: "chad",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  reviewState: null,
  commentCount: 0,
  lastReviewAt: null,
  ...over,
});

/** Answer per remote URL (the seam's dispatch is by resolved repo url);
 *  a missing key answers an empty list, an explicit null a host failure. */
const answers = (map: Record<string, PRSummary[] | null>): ListPRsFn =>
  async (_host, _credential, remoteUrl) => (remoteUrl in map ? map[remoteUrl] : []);

describe("loadPRDashboard (0053)", () => {
  it("filters to the repo's own credential (case-insensitive) and dedupes by canonical URL", async () => {
    const data = await loadPRDashboard(
      tdb,
      answers({
        "https://git.example.com/chad/shop": [
          pr({ number: 9, url: "https://git.example.com/chad/shop/pulls/9" }),
          pr({ number: 10, url: "https://git.example.com/chad/shop/pulls/10", author: "someone" }), // foreign
        ],
        "https://git.example.com/chad/shop.git": [
          // same PR (#9) from the second project's remote — one row
          pr({ number: 9, url: "https://git.example.com/chad/shop/pulls/9" }),
        ],
        "https://github.com/chad/web": [
          // this repo's credential is "ChadGH": case-insensitive match keeps it
          pr({ number: 3, url: "https://github.com/chad/web/pull/3", author: "chadgh" }),
        ],
        "https://git.example.com/chad/down": null, // host-null → failed, not fatal
        // unknown.example.com has no credential → failed
      }),
    );
    expect(data.prs.map((p) => p.url)).toEqual([
      "https://git.example.com/chad/shop/pulls/9",
      "https://github.com/chad/web/pull/3",
    ]);
    expect(data.reposQueried).toBe(3); // shop, shop(.git), web
    // The uncredentialed repo fails synchronously, before any host answer.
    expect(data.failedRepos).toEqual([
      { repo: "prsdash-a/unknown", reason: "no git credential matches https://unknown.example.com/o/r" },
      { repo: "prsdash-a/down", reason: "the host could not be asked (https://git.example.com/chad/down)" },
    ]);
  });

  it("orders open PRs by attention, then settled merged-before-closed, newest first", async () => {
    const data = await loadPRDashboard(
      tdb,
      answers({
        "https://git.example.com/chad/shop": [
          pr({ number: 1, url: "https://x.example/pulls/1", reviewState: "approved", updatedAt: "2026-10-07T00:00:00Z" }),
          pr({ number: 2, url: "https://x.example/pulls/2", reviewState: "changes-requested", updatedAt: "2026-10-01T00:00:00Z" }),
          pr({ number: 3, url: "https://x.example/pulls/3", reviewState: "commented", updatedAt: "2026-10-05T00:00:00Z" }),
          pr({ number: 4, url: "https://x.example/pulls/4", updatedAt: "2026-10-09T00:00:00Z" }),
          pr({ number: 5, url: "https://x.example/pulls/5", state: "merged", updatedAt: "2026-10-03T00:00:00Z" }),
          pr({ number: 6, url: "https://x.example/pulls/6", state: "closed", updatedAt: "2026-10-08T00:00:00Z" }),
          pr({ number: 7, url: "https://x.example/pulls/7", state: "merged", updatedAt: "2026-10-06T00:00:00Z" }),
        ],
      }),
    );
    expect(data.prs.map((p) => p.number)).toEqual([
      2, // changes requested — always first
      3, // then commented
      4, // then the rest by last activity (10-09 …
      1, // … 10-07)
      7, // settled: merged (10-06) …
      5, // … merged (10-03), before …
      6, // … closed (10-08) — merged sorts ahead of closed regardless of time
    ]);
  });

  it("a thrown seam answer is a failed repo, never a fatal page", async () => {
    const boom: ListPRsFn = async (_host, _credential, remoteUrl) => {
      if (remoteUrl.endsWith("/down")) throw new Error("git.example.com is down");
      return remoteUrl.endsWith("/shop") ? [pr({ number: 9, url: "https://git.example.com/chad/shop/pulls/9" })] : [];
    };
    const data = await loadPRDashboard(tdb, boom);
    expect(data.prs.map((p) => p.number)).toEqual([9]);
    expect(data.failedRepos).toContainEqual({
      repo: "prsdash-a/down",
      reason: "git.example.com is down",
    });
  });

  it("every empty answer yields no PRs — only the uncredentialed repo fails", async () => {
    const data = await loadPRDashboard(tdb, answers({}));
    expect(data).toEqual({
      prs: [],
      reposQueried: 4,
      failedRepos: [
        { repo: "prsdash-a/unknown", reason: "no git credential matches https://unknown.example.com/o/r" },
      ],
    });
  });
});
