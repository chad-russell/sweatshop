/**
 * Channel-principal attribute readers (0004/0007): the eve channel
 * lifts session-creation headers (x-sweatshop-project,
 * x-sweatshop-model) into the initiating principal's attributes,
 * immutable for the session's life. Runtime code — the agent's model
 * resolver, the sandbox selector, tools, the mirror hook — reads them
 * through these helpers instead of each call site re-casting the
 * attribute bag.
 */

/** The session shape the readers need (eve's ctx.session). */
interface SessionWithPrincipal {
  auth: { initiator?: { attributes?: unknown } | null };
}

function stringAttribute(
  session: SessionWithPrincipal,
  key: string,
): string | null {
  const attributes = session.auth.initiator?.attributes as
    | Record<string, unknown>
    | undefined;
  const value = attributes?.[key];
  return typeof value === "string" ? value : null;
}

/** The project this session is bound to at creation, or null (Chats). */
export function sessionProjectId(session: SessionWithPrincipal): string | null {
  return stringAttribute(session, "project");
}

/** The chat model this session runs on, or null (default applies). */
export function sessionModelId(session: SessionWithPrincipal): string | null {
  return stringAttribute(session, "model");
}
