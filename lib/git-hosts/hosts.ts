import type { GitHost } from "@/lib/git-hosts/index";
import { forgejoHost } from "@/lib/git-hosts/forgejo";
import { githubHost } from "@/lib/git-hosts/github";

/**
 * The registry of installed GitHost implementations (0004 seam).
 * Everything that resolves credentials by host — workspace setup, the
 * create_pr tool, the run_ticket workflow — imports this one array, so
 * a new host lands everywhere at once.
 */
export const GIT_HOSTS: readonly GitHost[] = [githubHost, forgejoHost];
