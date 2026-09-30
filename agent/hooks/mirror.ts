import { defineHook } from "eve/hooks";
import { mirrorStreamEvent } from "../../db/mirror";

/**
 * 0002/0004: mirror every durable stream event into sweatshop's sqlite
 * store (conversations index + append-only event log), stamping each
 * conversation's immutable project binding from the session's initiating
 * principal (x-sweatshop-project → channel auth attributes). Hooks
 * observe events after they are durably recorded and receive the full
 * envelope — meta.id is the idempotency key. This fires for sessions
 * from any client of the eve channel; the mirror is failsafe by
 * construction.
 */
export default defineHook({
  events: {
    "*": (event, ctx) => {
      const attributes = ctx.session.auth.initiator?.attributes as
        | { project?: unknown }
        | undefined;
      const projectId =
        typeof attributes?.project === "string" ? attributes.project : null;
      mirrorStreamEvent(ctx.session.id, event, { projectId });
    },
  },
});
