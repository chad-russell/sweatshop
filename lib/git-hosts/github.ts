import {
  installCredentialStore,
  postJSON,
  remoteHost,
  repoPath,
  type CreatePRInput,
  type CreatePRResult,
  type GitHost,
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
    return { url } satisfies CreatePRResult;
  },
};
