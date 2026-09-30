import {
  installCredentialStore,
  type GitHost,
} from "@/lib/git-hosts/index";
import { remoteHost } from "@/lib/git-hosts/index";

/** GitHub: token-authenticated https, host scope github.com. */
export const githubHost: GitHost = {
  kind: "github",
  matchesHost(remoteUrl) {
    return remoteHost(remoteUrl) === "github.com";
  },
  async installAuth(sandbox, credential) {
    await installCredentialStore(sandbox, "github.com", credential);
  },
};
