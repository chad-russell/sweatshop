import {
  installCredentialStore,
  postJSON,
  remoteHost,
  repoPath,
  type CreatePRInput,
  type CreatePRResult,
  type GitHost,
} from "@/lib/git-hosts/index";

/** Forgejo: token-authenticated https against a self-hosted instance. */
export const forgejoHost: GitHost = {
  kind: "forgejo",
  matchesHost(remoteUrl, credential) {
    if (!credential.baseUrl) return false;
    return remoteHost(remoteUrl) === remoteHost(credential.baseUrl);
  },
  async installAuth(sandbox, credential) {
    if (!credential.baseUrl) {
      throw new Error("forgejo credential requires baseUrl");
    }
    const host = remoteHost(credential.baseUrl);
    if (!host) throw new Error(`unparseable forgejo baseUrl: ${credential.baseUrl}`);
    await installCredentialStore(sandbox, host, credential);
  },
  async createPR(credential, input: CreatePRInput, fetchImpl = fetch) {
    if (!credential.baseUrl) {
      throw new Error("forgejo credential requires baseUrl");
    }
    const path = repoPath(input.remoteUrl);
    if (!path) throw new Error(`unparseable remote: ${input.remoteUrl}`);
    const base = credential.baseUrl.replace(/\/$/, "");
    // Basic auth (username + secret): Forgejo accepts an account password
    // OR a PAT here, unlike `Authorization: token` which requires a PAT.
    const basic = Buffer.from(
      `${credential.username}:${credential.secret}`,
    ).toString("base64");
    const json = await postJSON(
      `${base}/api/v1/repos/${path.owner}/${path.repo}/pulls`,
      { authorization: `Basic ${basic}` },
      {
        head: input.head,
        base: input.base ?? "main",
        title: input.title,
        body: input.body ?? "",
      },
      fetchImpl,
    );
    const url = json.html_url;
    if (typeof url !== "string") throw new Error("forgejo PR response missing html_url");
    const number = json.number;
    if (typeof number !== "number") throw new Error("forgejo PR response missing number");
    return { url, number } satisfies CreatePRResult;
  },
};
