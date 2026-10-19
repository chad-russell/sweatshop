import {
  actorLogin,
  getJSON,
  headRef,
  installCredentialStore,
  jsonField,
  listPRsWithReviews,
  postJSON,
  remoteHost,
  repoPath,
  strField,
  type CreatePRInput,
  type CreatePRResult,
  type GitHost,
  type PRState,
  type PRSummary,
  type ReviewSignal,
} from "@/lib/git-hosts/index";

/** GitHub review `state` strings → the dashboard verdict vocabulary. */
const GH_REVIEW_STATE: Record<string, ReviewSignal["state"]> = {
  CHANGES_REQUESTED: "changes-requested",
  APPROVED: "approved",
  COMMENTED: "commented",
};

/** One `…/pulls` row → a summary, or null on an untrusted shape
 *  (`user.login` is the author, `merged_at` set → merged). */
function ghPRSummary(row: unknown): PRSummary | null {
  const title = strField(row, "title");
  const url = strField(row, "html_url");
  const head = headRef(jsonField(row, "head"));
  const author = actorLogin(jsonField(row, "user"));
  const createdAt = strField(row, "created_at");
  const updatedAt = strField(row, "updated_at");
  const number = jsonField(row, "number");
  const comments = jsonField(row, "comments");
  const mergedAt = strField(row, "merged_at");
  const state = strField(row, "state");
  if (
    !title || !url || !head || !author || !createdAt || !updatedAt ||
    typeof number !== "number" || !state
  ) {
    return null;
  }
  const lifecycle = mergedAt ? "merged" : state === "closed" ? "closed" : state === "open" ? "open" : null;
  if (!lifecycle) return null;
  return {
    number,
    title,
    url,
    state: lifecycle,
    head,
    author,
    createdAt,
    updatedAt,
    reviewState: null,
    commentCount: typeof comments === "number" ? comments : null,
    lastReviewAt: null,
  };
}

/** One `…/pulls/{n}/reviews` row → a signal; an unshaped row → null. */
function ghReviewSignal(row: unknown): ReviewSignal | null {
  const reviewer = actorLogin(jsonField(row, "user"));
  const raw = strField(row, "state");
  const state = raw ? GH_REVIEW_STATE[raw] : undefined;
  if (!reviewer || !state) return null;
  return { reviewer, state, submittedAt: strField(row, "submitted_at") };
}

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
  async listPRs(credential, remoteUrl, fetchImpl = fetch): Promise<PRSummary[] | null> {
    const path = repoPath(remoteUrl);
    if (!path) return null;
    const owner = encodeURIComponent(path.owner);
    const repo = encodeURIComponent(path.repo);
    return listPRsWithReviews({
      listUrl: `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&per_page=50`,
      reviewsUrl: (number) =>
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/reviews`,
      headers: {
        authorization: `Bearer ${credential.secret}`,
        accept: "application/vnd.github+json",
      },
      username: credential.username,
      parsePR: ghPRSummary,
      parseReview: ghReviewSignal,
      fetchImpl,
    });
  },
};
