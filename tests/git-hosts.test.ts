import { describe, expect, it } from "vitest";
import type { GitCredential } from "../db/schema";
import {
  credentialStoreLine,
  httpsRemote,
  remoteHost,
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
