import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { gitCredentials } from "../db/schema";
import {
  createGitCredential,
  listGitCredentialViews,
  secretHint,
  updateGitCredential,
} from "../lib/git-hosts/credential-admin";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

describe("git credential admin", () => {
  beforeEach(() => {
    db().delete(gitCredentials).run();
  });

  it("hints show the token's start and end only", () => {
    expect(secretHint(SECRET)).toBe("ghp_abcd…6789");
    expect(secretHint("short")).toBe("•••••");
  });

  it("creates, lists without the secret, and updates", () => {
    expect(createGitCredential(db(), { kind: "github", username: "Me", secret: SECRET })).toEqual({ ok: true });
    const [row] = listGitCredentialViews(db());
    expect(row).toMatchObject({ id: "github-me", username: "Me", baseUrl: null });
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(updateGitCredential(db(), "github-me", "ghp_newtoken_000000000000")).toEqual({ ok: true });
    expect(listGitCredentialViews(db())[0].hint).toBe("ghp_newt…0000");
  });

  it("rejects bad input, duplicates and unknown ids", () => {
    expect(createGitCredential(db(), { kind: "gitlab", username: "x", secret: "y" })).toMatchObject({ status: 400 });
    expect(createGitCredential(db(), { kind: "forgejo", username: "x", secret: "y" })).toMatchObject({ status: 400 });
    createGitCredential(db(), { kind: "github", username: "me", secret: SECRET });
    expect(createGitCredential(db(), { kind: "github", username: "me", secret: SECRET })).toMatchObject({ status: 409 });
    expect(updateGitCredential(db(), "nope", SECRET)).toMatchObject({ status: 404 });
    expect(updateGitCredential(db(), "github-me", "  ")).toMatchObject({ status: 400 });
  });
});
