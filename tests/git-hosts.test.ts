import { describe, expect, it } from "vitest";
import type { GitCredential } from "../db/schema";
import {
  credentialStoreLine,
  httpsRemote,
  remoteHost,
  repoPath,
  resolveCredential,
} from "../lib/git-hosts";
import { forgejoHost } from "../lib/git-hosts/forgejo";
import { githubHost } from "../lib/git-hosts/github";

const HOSTS = [githubHost, forgejoHost];

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
