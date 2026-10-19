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

/**
 * Forgejo review `state` strings (gitea modules/structs: "APPROVED",
 * "REQUEST_CHANGES", "COMMENT", plus PENDING/AWAIT which never reach a
 * verdict) → the dashboard vocabulary. Pure — pinned by tests.
 */
const FJ_REVIEW_STATE: Record<string, ReviewSignal["state"]> = {
  APPROVED: "approved",
  REQUEST_CHANGES: "changes-requested",
  COMMENT: "commented",
};

/** One `/pulls` list row → a summary, or null on an untrusted shape
 *  (`poster.login` is the author, a `merged` timestamp → merged). */
function fjPRSummary(row: unknown): PRSummary | null {
  const title = strField(row, "title");
  const url = strField(row, "html_url");
  const head = headRef(jsonField(row, "head"));
  const author = actorLogin(jsonField(row, "poster"));
  const createdAt = strField(row, "created_at");
  const updatedAt = strField(row, "updated_at");
  const number = jsonField(row, "number");
  const comments = jsonField(row, "comments");
  const merged = strField(row, "merged");
  const state = strField(row, "state");
  if (
    !title || !url || !head || !author || !createdAt || !updatedAt ||
    typeof number !== "number" || !state
  ) {
    return null;
  }
  const lifecycle = merged ? "merged" : state === "closed" ? "closed" : state === "open" ? "open" : null;
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

/** One `/pulls/{n}/reviews` row → a signal; an unshaped or dismissed
 *  row → null (`reviewer.login`, `state`, `submitted_at`). */
function fjReviewSignal(row: unknown): ReviewSignal | null {
  if (jsonField(row, "dismissed") === true) return null;
  const reviewer = actorLogin(jsonField(row, "reviewer"));
  const raw = strField(row, "state");
  const state = raw ? FJ_REVIEW_STATE[raw] : undefined;
  if (!reviewer || !state) return null;
  return { reviewer, state, submittedAt: strField(row, "submitted_at") };
}

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
  async listPRs(credential, remoteUrl, fetchImpl = fetch): Promise<PRSummary[] | null> {
    if (!credential.baseUrl) return null;
    const path = repoPath(remoteUrl);
    if (!path) return null;
    const base = credential.baseUrl.replace(/\/$/, "");
    const owner = encodeURIComponent(path.owner);
    const repo = encodeURIComponent(path.repo);
    // Basic auth (username + secret): Forgejo accepts an account password
    // OR a PAT here, unlike `Authorization: token` which requires a PAT.
    const basic = Buffer.from(
      `${credential.username}:${credential.secret}`,
    ).toString("base64");
    return listPRsWithReviews({
      listUrl: `${base}/api/v1/repos/${owner}/${repo}/pulls?state=all&limit=50`,
      reviewsUrl: (number) =>
        `${base}/api/v1/repos/${owner}/${repo}/pulls/${number}/reviews`,
      headers: { authorization: `Basic ${basic}` },
      username: credential.username,
      parsePR: fjPRSummary,
      parseReview: fjReviewSignal,
      fetchImpl,
    });
  },
};
