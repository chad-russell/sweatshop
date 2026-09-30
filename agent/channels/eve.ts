import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * sweatshop is a LAN-only personal tool — the Next.js app itself has no
 * auth — so every caller is admitted as the synthetic `chad` principal.
 * principalType "user" keeps the observability audience `private` (the
 * conversations are Chad's own data).
 *
 * Attributes (immutable for the session's life, read by runtime code):
 * - `project` — x-sweatshop-project: the project this conversation is
 *   bound to at creation (0004). The sandbox selector materializes that
 *   project's repos; the mirror stamps conversations.project_id.
 * - `model` — x-sweatshop-model: the chat model this conversation runs
 *   on (agent/agent.ts resolves it at every model step; unknown ids
 *   fall back to the default there).
 *
 * HARD RULE: replace this with a real verifier (httpBasic / jwtHmac /
 * oidc — see eve's Authentication docs) before any internet exposure.
 */
const lanAuth: AuthFn<Request> = async (request) => {
  const attributes: Record<string, string> = {};
  const project = request.headers.get("x-sweatshop-project")?.slice(0, 64);
  if (project) attributes.project = project;
  const model = request.headers.get("x-sweatshop-model")?.slice(0, 64);
  if (model) attributes.model = model;
  return {
    authenticator: "sweatshop-lan",
    principalId: "chad",
    principalType: "user",
    attributes,
  };
};

export default eveChannel({ auth: [lanAuth] });
