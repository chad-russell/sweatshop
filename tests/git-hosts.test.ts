import { describe, expect, it } from "vitest";
import type { GitCredential } from "../db/schema";
import {
  credentialStoreLine,
  httpsRemote,
  remoteHost,
  repoPath,
  resolveCredential,
} from "../lib/git-hosts";
import { GIT_HOSTS } from "../lib/git-hosts/hosts";
import { forgejoHost } from "../lib/git-hosts/forgejo";
import { githubHost } from "../lib/git-hosts/github";

// The canonical registry — the same array production code resolves
// against, so a host missing from it fails here too.
const HOSTS = GIT_HOSTS;

const cred = (over: Partial<GitCredential>): GitCredential => ({
  id: "test",
  kind: "github",
  label: "test",
  username: "chad",
  secret: "tok",
  baseUrl: null,
  createdAt: 0,
  ...over,
});

describe("remoteHost", () => {
  it("parses https remotes", () => {
    expect(remoteHost("https://github.com/owner/repo.git")).toBe("github.com");
    expect(remoteHost("https://user@forgejo.example.com/o/r")).toBe(
      "forgejo.example.com",
    );
  });

  it("parses ssh remotes", () => {
    expect(remoteHost("git@github.com:owner/repo.git")).toBe("github.com");
    expect(remoteHost("git@forgejo.internal:crussell/skills.git")).toBe(
      "forgejo.internal",
    );
  });

  it("returns null for garbage", () => {
    expect(remoteHost("not a remote")).toBeNull();
  });
});

describe("httpsRemote", () => {
  it("rewrites ssh remotes to https", () => {
    expect(httpsRemote("git@github.com:owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
  });

  it("passes https remotes through", () => {
    expect(httpsRemote("https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
  });
});

describe("credentialStoreLine", () => {
  it("url-encodes username and secret", () => {
    expect(credentialStoreLine("github.com", "a@b", "t/k+")).toBe(
      "https://a%40b:t%2Fk%2B@github.com",
    );
  });
});

describe("resolveCredential (host-scope rule)", () => {
  it("github credential covers any github.com remote", () => {
    const resolved = resolveCredential(
      "https://github.com/owner/repo.git",
      [cred({ id: "gh", kind: "github" })],
      HOSTS,
    );
    expect(resolved?.host.kind).toBe("github");
    expect(resolved?.credential.id).toBe("gh");
  });

  it("forgejo credential covers only its instance host", () => {
    const fj = cred({
      id: "fj",
      kind: "forgejo",
      baseUrl: "https://forgejo.internal",
    });
    expect(
      resolveCredential("https://forgejo.internal/crussell/skills.git", [fj], HOSTS)
        ?.credential.id,
    ).toBe("fj");
    expect(
      resolveCredential("https://github.com/owner/repo.git", [fj], HOSTS),
    ).toBeUndefined();
  });

  it("returns undefined with no matching credential", () => {
    expect(
      resolveCredential("https://example.com/o/r", [], HOSTS),
    ).toBeUndefined();
  });
});

describe("repoPath", () => {
  it("parses https and ssh remotes, stripping .git", () => {
    expect(repoPath("https://github.com/owner/repo.git")).toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
    expect(repoPath("git@git.crussell.io:chad/sweatshop-e2e-scratch.git")).toEqual({
      host: "git.crussell.io",
      owner: "chad",
      repo: "sweatshop-e2e-scratch",
    });
  });

  it("returns null for remotes without an owner/repo tail", () => {
    expect(repoPath("https://github.com")).toBeNull();
  });
});

/** fetch stub capturing the outgoing request and replying with JSON. */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const impl: typeof fetch = async (url, init) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

describe("GitHost.createPR", () => {
  const input = (remoteUrl: string) => ({
    remoteUrl,
    head: "feature/x",
    title: "Add x",
    body: "does x",
  });

  it("github posts to the pulls API with bearer auth", async () => {
    const { impl, calls } = stubFetch(201, { html_url: "https://github.com/o/r/pull/1", number: 1 });
    const gh = cred({ id: "gh", kind: "github" });
    const result = await githubHost.createPR(gh, input("https://github.com/o/r.git"), impl);
    expect(result.url).toBe("https://github.com/o/r/pull/1");
    expect(result.number).toBe(1);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/pulls");
    expect(calls[0]?.headers.authorization).toBe("Bearer tok");
    expect(calls[0]?.body).toEqual({
      head: "feature/x",
      base: "main",
      title: "Add x",
      body: "does x",
    });
  });

  it("forgejo posts to the instance API with basic auth", async () => {
    const { impl, calls } = stubFetch(201, { html_url: "https://git.example.com/o/r/pulls/2", number: 2 });
    const fj = cred({
      id: "fj",
      kind: "forgejo",
      baseUrl: "https://git.example.com",
    });
    const result = await forgejoHost.createPR(
      fj,
      input("https://git.example.com/o/r.git"),
      impl,
    );
    expect(result.url).toBe("https://git.example.com/o/r/pulls/2");
    expect(result.number).toBe(2);
    expect(calls[0]?.url).toBe("https://git.example.com/api/v1/repos/o/r/pulls");
    const expected = Buffer.from("chad:tok").toString("base64");
    expect(calls[0]?.headers.authorization).toBe(`Basic ${expected}`);
  });

  it("surfaces provider errors with status and message", async () => {
    const { impl } = stubFetch(422, { message: "pull request already exists" });
    const gh = cred({ id: "gh", kind: "github" });
    await expect(
      githubHost.createPR(gh, input("https://github.com/o/r.git"), impl),
    ).rejects.toThrow(/422: pull request already exists/);
  });
});

describe("GitHost.getPRState (0052)", () => {
  const gh = cred({ id: "gh", kind: "github" });
  const fj = cred({ id: "fj", kind: "forgejo", baseUrl: "https://git.example.com" });

  it("github asks the pulls API with bearer auth and maps merged", async () => {
    const { impl, calls } = stubFetch(200, {
      state: "closed",
      merged: true,
      merged_at: "2026-10-01T10:00:00Z",
    });
    expect(await githubHost.getPRState(gh, "https://github.com/o/r.git", 7, impl)).toEqual({
      state: "merged",
      mergedAt: "2026-10-01T10:00:00Z",
    });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/pulls/7");
    expect(calls[0]?.headers.authorization).toBe("Bearer tok");
    expect(calls[0]?.headers.accept).toBe("application/vnd.github+json");
  });

  it("github maps merged without a timestamp, closed, and open", async () => {
    const noTime = stubFetch(200, { state: "closed", merged: true, merged_at: null });
    expect(await githubHost.getPRState(gh, "https://github.com/o/r.git", 7, noTime.impl)).toEqual({
      state: "merged",
    });
    const closed = stubFetch(200, { state: "closed", merged: false });
    expect(await githubHost.getPRState(gh, "https://github.com/o/r.git", 7, closed.impl)).toEqual({
      state: "closed",
    });
    const open = stubFetch(200, { state: "open", merged: false });
    expect(await githubHost.getPRState(gh, "https://github.com/o/r.git", 7, open.impl)).toEqual({
      state: "open",
    });
  });

  it("github returns null on 404, a garbage shape, or an unparseable remote", async () => {
    const notFound = stubFetch(404, { message: "Not Found" });
    expect(await githubHost.getPRState(gh, "https://github.com/o/r.git", 7, notFound.impl)).toBeNull();
    const garbage = stubFetch(200, { title: "not a pull request" });
    expect(await githubHost.getPRState(gh, "https://github.com/o/r.git", 7, garbage.impl)).toBeNull();
    const fine = stubFetch(200, { state: "open" });
    expect(await githubHost.getPRState(gh, "garbage", 7, fine.impl)).toBeNull();
  });

  it("forgejo asks the instance API with basic auth and maps its merged timestamp", async () => {
    const { impl, calls } = stubFetch(200, { state: "open", merged: "2026-10-02T09:00:00Z" });
    expect(await forgejoHost.getPRState(fj, "https://git.example.com/o/r", 2, impl)).toEqual({
      state: "merged",
      mergedAt: "2026-10-02T09:00:00Z",
    });
    expect(calls[0]?.url).toBe("https://git.example.com/api/v1/repos/o/r/pulls/2");
    const expected = Buffer.from("chad:tok").toString("base64");
    expect(calls[0]?.headers.authorization).toBe(`Basic ${expected}`);
  });

  it("forgejo maps closed and open", async () => {
    const closed = stubFetch(200, { state: "closed", merged: null });
    expect(await forgejoHost.getPRState(fj, "https://git.example.com/o/r", 2, closed.impl)).toEqual({
      state: "closed",
    });
    const open = stubFetch(200, { state: "open", merged: null });
    expect(await forgejoHost.getPRState(fj, "https://git.example.com/o/r", 2, open.impl)).toEqual({
      state: "open",
    });
  });

  it("forgejo returns null on 404, a garbage shape, or a missing baseUrl", async () => {
    const notFound = stubFetch(404, { message: "Not Found" });
    expect(await forgejoHost.getPRState(fj, "https://git.example.com/o/r", 2, notFound.impl)).toBeNull();
    const garbage = stubFetch(200, {});
    expect(await forgejoHost.getPRState(fj, "https://git.example.com/o/r", 2, garbage.impl)).toBeNull();
    const fine = stubFetch(200, { state: "open" });
    expect(
      await forgejoHost.getPRState(cred({ kind: "forgejo" }), "https://git.example.com/o/r", 2, fine.impl),
    ).toBeNull();
  });
});

describe("GitHost.listPRs (0053)", () => {
  const gh = cred({ id: "gh", kind: "github" });
  const fj = cred({ id: "fj", kind: "forgejo", baseUrl: "https://git.example.com" });

  /** fetch stub answering per-URL (a list + per-PR reviews), recording calls. */
  function routeFetch(body: (url: string) => unknown, status = 200) {
    const calls: string[] = [];
    const impl: typeof fetch = async (url) => {
      const target = String(url);
      calls.push(target);
      return new Response(JSON.stringify(body(target)), {
        status,
        headers: { "content-type": "application/json" },
      });
    };
    return { impl, calls };
  }

  /** A github list row in the API's own shape. */
  const ghRow = (over: Record<string, unknown>) => ({
    number: 1,
    title: "Add thing",
    html_url: "https://github.com/o/r/pull/1",
    state: "open",
    merged_at: null,
    user: { login: "chad" },
    head: { ref: "feat/thing" },
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-02T10:00:00Z",
    comments: 0,
    ...over,
  });

  /** A github reviews array in the API's own shape. */
  const ghReviews = (...rows: Record<string, unknown>[]) => rows;

  it("github lists with bearer auth, maps rows, and aggregates the verdict", async () => {
    const { impl, calls } = routeFetch((url) => {
      if (url.endsWith("/pulls/7/reviews")) {
        return ghReviews(
          { user: { login: "alice" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-02T09:00:00Z" },
          { user: { login: "bob" }, state: "APPROVED", submitted_at: "2026-10-03T09:00:00Z" },
        );
      }
      return [
        ghRow({
          number: 7,
          title: "Needs work",
          html_url: "https://github.com/o/r/pull/7",
          user: { login: "Chad" }, // author match is case-insensitive
          comments: 2,
          updated_at: "2026-10-03T10:00:00Z",
        }),
        // settled by chad → merged, never asked for reviews
        ghRow({ number: 6, state: "closed", merged_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-20T10:00:00Z" }),
        // open but someone else's → listed, never asked for reviews
        ghRow({ number: 5, user: { login: "someone" } }),
      ];
    });
    const prs = await githubHost.listPRs(gh, "https://github.com/o/r.git", impl);
    expect(prs).toEqual([
      {
        number: 7,
        title: "Needs work",
        url: "https://github.com/o/r/pull/7",
        state: "open",
        head: "feat/thing",
        author: "Chad",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-03T10:00:00Z",
        reviewState: "changes-requested", // one blocker beats one approval
        commentCount: 2,
        lastReviewAt: "2026-10-03T09:00:00Z",
      },
      {
        number: 6,
        title: "Add thing",
        url: "https://github.com/o/r/pull/1",
        state: "merged",
        head: "feat/thing",
        author: "chad",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-09-20T10:00:00Z",
        reviewState: null,
        commentCount: 0,
        lastReviewAt: null,
      },
      {
        number: 5,
        title: "Add thing",
        url: "https://github.com/o/r/pull/1",
        state: "open",
        head: "feat/thing",
        author: "someone",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-02T10:00:00Z",
        reviewState: null,
        commentCount: 0,
        lastReviewAt: null,
      },
    ]);
    // One list call (path-encoded owner/repo, bearer auth) + one reviews
    // call for the only OPEN PR by the account — settled and foreign PRs
    // are never asked.
    expect(calls).toEqual([
      "https://api.github.com/repos/o/r/pulls?state=all&per_page=50",
      "https://api.github.com/repos/o/r/pulls/7/reviews",
    ]);
  });

  it("github aggregates per reviewer: the latest review wins, then changes > approved > commented", async () => {
    const { impl } = routeFetch((url) => {
      if (url.endsWith("/pulls/1/reviews")) {
        return ghReviews(
          // alice's latest (11:00) is a plain comment, superseding her 10:00 approval
          { user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-10-02T10:00:00Z" },
          { user: { login: "alice" }, state: "COMMENTED", submitted_at: "2026-10-02T11:00:00Z" },
          { user: { login: "bob" }, state: "APPROVED", submitted_at: "2026-10-02T12:00:00Z" },
        );
      }
      return [ghRow({})];
    });
    const [pr] = (await githubHost.listPRs(gh, "https://github.com/o/r", impl))!;
    expect(pr.reviewState).toBe("approved"); // bob's approval outranks alice's comment
    expect(pr.lastReviewAt).toBe("2026-10-02T12:00:00Z");

    const noReviews = routeFetch(() => [ghRow({})]);
    const [bare] = (await githubHost.listPRs(gh, "https://github.com/o/r", noReviews.impl))!;
    expect(bare.reviewState).toBeNull();
    expect(bare.lastReviewAt).toBeNull();
  });

  it("github bounds review fetches at the first 25 open PRs by the account", async () => {
    const rows = Array.from({ length: 26 }, (_, i) => ghRow({ number: i + 1 }));
    const { impl, calls } = routeFetch((url) =>
      url.endsWith("/reviews") ? [] : rows,
    );
    const prs = (await githubHost.listPRs(gh, "https://github.com/o/r", impl))!;
    expect(prs).toHaveLength(26);
    // 1 list call + reviews for the first 25; the 26th is never asked.
    expect(calls).toHaveLength(26);
    expect(calls.filter((url) => url.endsWith("/reviews"))).toHaveLength(25);
    expect(prs[24]!.reviewState).toBeNull(); // empty reviews array → null, not a fetch error
    expect(prs[24]!.lastReviewAt).toBeNull();
  });

  it("github returns null on a host error, a rejected fetch, a non-array body, or an unparseable remote", async () => {
    const error = routeFetch(() => ({ message: "boom" }), 500);
    expect(await githubHost.listPRs(gh, "https://github.com/o/r", error.impl)).toBeNull();
    const down: typeof fetch = async () => {
      throw new Error("network");
    };
    expect(await githubHost.listPRs(gh, "https://github.com/o/r", down)).toBeNull();
    const shaped = routeFetch(() => ({ not: "a list" }));
    expect(await githubHost.listPRs(gh, "https://github.com/o/r", shaped.impl)).toBeNull();
    const fine = routeFetch(() => []);
    expect(await githubHost.listPRs(gh, "garbage", fine.impl)).toBeNull();
  });

  /** A forgejo list row in the API's own shape. */
  const fjRow = (over: Record<string, unknown>) => ({
    number: 1,
    title: "Add thing",
    html_url: "https://git.example.com/o/r/pulls/1",
    state: "open",
    merged: null,
    poster: { login: "chad" },
    head: { ref: "feat/thing" },
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-02T10:00:00Z",
    comments: 0,
    ...over,
  });

  it("forgejo lists with basic auth, maps rows, and aggregates REQUEST_CHANGES", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const impl: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      const body = String(url).endsWith("/reviews")
        ? [
            { reviewer: { login: "glen" }, state: "REQUEST_CHANGES", submitted_at: "2026-10-02T09:00:00Z" },
            { reviewer: { login: "mia" }, state: "COMMENT", submitted_at: "2026-10-02T08:00:00Z" },
          ]
        : [
            fjRow({ number: 2, html_url: "https://git.example.com/o/r/pulls/2", comments: 3, updated_at: "2026-10-03T10:00:00Z" }),
            // forgejo's `merged` IS the timestamp
            fjRow({ number: 1, state: "closed", merged: "2026-09-20T10:00:00Z", updated_at: "2026-09-20T10:00:00Z" }),
          ];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const prs = (await forgejoHost.listPRs(fj, "https://git.example.com/o/r", impl))!;
    expect(prs[0]).toEqual({
      number: 2,
      title: "Add thing",
      url: "https://git.example.com/o/r/pulls/2",
      state: "open",
      head: "feat/thing",
      author: "chad",
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-03T10:00:00Z",
      reviewState: "changes-requested",
      commentCount: 3,
      lastReviewAt: "2026-10-02T09:00:00Z",
    });
    expect(prs[1]).toMatchObject({ number: 1, state: "merged", reviewState: null });
    expect(seen.map((c) => c.url)).toEqual([
      "https://git.example.com/api/v1/repos/o/r/pulls?state=all&limit=50",
      "https://git.example.com/api/v1/repos/o/r/pulls/2/reviews",
    ]);
    const expected = Buffer.from("chad:tok").toString("base64");
    expect(seen[0]!.headers.authorization).toBe(`Basic ${expected}`);
  });

  it("forgejo auth is basic and a dismissed review never counts", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const impl: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      const body = String(url).endsWith("/reviews")
        ? [
            { reviewer: { login: "glen" }, state: "REQUEST_CHANGES", submitted_at: "2026-10-02T09:00:00Z", dismissed: true },
            { reviewer: { login: "mia" }, state: "APPROVED", submitted_at: "2026-10-02T10:00:00Z" },
          ]
        : [fjRow({})];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const [pr] = (await forgejoHost.listPRs(fj, "https://git.example.com/o/r", impl))!;
    expect(pr.reviewState).toBe("approved"); // the dismissed blocker is dropped
    const expected = Buffer.from("chad:tok").toString("base64");
    expect(seen[0]).toEqual({
      url: "https://git.example.com/api/v1/repos/o/r/pulls?state=all&limit=50",
      headers: { authorization: `Basic ${expected}` },
    });
  });

  it("forgejo returns null on a host error, a missing baseUrl, or an unparseable remote", async () => {
    const error = routeFetch(() => ({ message: "boom" }), 404);
    expect(await forgejoHost.listPRs(fj, "https://git.example.com/o/r", error.impl)).toBeNull();
    const fine = routeFetch(() => []);
    expect(
      await forgejoHost.listPRs(cred({ kind: "forgejo" }), "https://git.example.com/o/r", fine.impl),
    ).toBeNull();
    expect(await forgejoHost.listPRs(fj, "garbage", fine.impl)).toBeNull();
  });
});
