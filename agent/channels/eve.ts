import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * sweatshop is a LAN-only personal tool — the Next.js app itself has no
 * auth — so every caller is admitted as the synthetic `chad` principal.
 * principalType "user" keeps the observability audience `private` (the
 * conversations are Chad's own data).
 *
 * HARD RULE: replace this with a real verifier (httpBasic / jwtHmac /
 * oidc — see eve's Authentication docs) before any internet exposure.
 */
const lanAuth: AuthFn<Request> = async () => ({
  authenticator: "sweatshop-lan",
  principalId: "chad",
  principalType: "user",
  attributes: {},
});

export default eveChannel({ auth: [lanAuth] });
