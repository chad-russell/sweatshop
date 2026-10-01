import { defineTool } from "eve/tools";
import { z } from "zod";
import { openProjectPR } from "../../lib/git-hosts/open-pr";
import { sessionProjectId } from "../../lib/session-attributes";

/**
 * 0004 Phase D: open a pull request on one of the bound project's repos.
 * Thin by design — the shared core (lib/git-hosts/open-pr) resolves
 * project → repo → host-scoped credential; GitHost does the rest.
 */
export default defineTool({
  description:
    "Open a pull request for a branch of one of this project's repos " +
    "(github or forgejo). Push the branch first (git push in the sandbox).",
  inputSchema: z.object({
    repo: z.string().describe("Repo directory name under /workspace"),
    head: z.string().describe("Branch containing the work"),
    base: z.string().optional().describe("Target branch (default: main)"),
    title: z.string().min(1),
    body: z.string().optional(),
  }),
  async execute({ repo, head, base, title, body }, ctx) {
    const projectId = sessionProjectId(ctx.session);
    if (!projectId) {
      throw new Error("no project bound to this conversation");
    }
    return openProjectPR({ projectId, repo, head, base, title, body });
  },
});
