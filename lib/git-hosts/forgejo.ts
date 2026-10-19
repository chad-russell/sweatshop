import {
  getJSON,
  installCredentialStore,
  postJSON,
  remoteHost,
  repoPath,
  type CreatePRInput,
  type CreatePRResult,
  type GitHost,
  type PRState,
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
  async getPRState(credential, remoteUrl, number, fetchImpl = fetch): Promise<PRState | null> {
    try {
      if (!credential.baseUrl) return null;
      const path = repoPath(remoteUrl);
      if (!path) return null;
      const base = credential.baseUrl.replace(/\/$/, "");
      const basic = Buffer.from(
        `${credential.username}:${credential.secret}`,
      ).toString("base64");
      const json = await getJSON(
        `${base}/api/v1/repos/${encodeURIComponent(path.owner)}/${encodeURIComponent(path.repo)}/pulls/${number}`,
        { authorization: `Basic ${basic}` },
        fetchImpl,
      );
      // Forgejo's `merged` is the merge timestamp (falsy until merged).
      if (json.merged) {
        const mergedAt = json.merged;
        return { state: "merged", ...(typeof mergedAt === "string" ? { mergedAt } : {}) };
      }
      if (json.state === "closed") return { state: "closed" };
      if (json.state === "open") return { state: "open" };
      return null; // shape error
    } catch {
      return null; // non-2xx, network, or parse failure — unknown, never thrown
    }
  },
};
