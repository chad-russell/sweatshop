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

/** GitHub: token-authenticated https, host scope github.com. */
export const githubHost: GitHost = {
  kind: "github",
  matchesHost(remoteUrl) {
    return remoteHost(remoteUrl) === "github.com";
  },
  async installAuth(sandbox, credential) {
    await installCredentialStore(sandbox, "github.com", credential);
  },
  async createPR(credential, input: CreatePRInput, fetchImpl = fetch) {
    const path = repoPath(input.remoteUrl);
    if (!path) throw new Error(`unparseable remote: ${input.remoteUrl}`);
    const json = await postJSON(
      `https://api.github.com/repos/${path.owner}/${path.repo}/pulls`,
      {
        authorization: `Bearer ${credential.secret}`,
        accept: "application/vnd.github+json",
      },
      {
        head: input.head,
        base: input.base ?? "main",
        title: input.title,
        body: input.body ?? "",
      },
      fetchImpl,
    );
    const url = json.html_url;
    if (typeof url !== "string") throw new Error("github PR response missing html_url");
    const number = json.number;
    if (typeof number !== "number") throw new Error("github PR response missing number");
    return { url, number } satisfies CreatePRResult;
  },
  async getPRState(credential, remoteUrl, number, fetchImpl = fetch): Promise<PRState | null> {
    try {
      const path = repoPath(remoteUrl);
      if (!path) return null;
      const json = await getJSON(
        `https://api.github.com/repos/${encodeURIComponent(path.owner)}/${encodeURIComponent(path.repo)}/pulls/${number}`,
        {
          authorization: `Bearer ${credential.secret}`,
          accept: "application/vnd.github+json",
        },
        fetchImpl,
      );
      if (json.merged === true) {
        const mergedAt = json.merged_at;
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
