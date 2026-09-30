import {
  installCredentialStore,
  remoteHost,
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
};
