import { defineHook } from "eve/hooks";
import { mirrorStreamEvent } from "../../db/mirror";

/**
 * 0002: mirror every durable stream event into sweatshop's sqlite store
 * (conversations index + append-only event log). Hooks observe events
 * after they are durably recorded and receive the full envelope —
 * meta.id is the idempotency key. This fires for sessions from any
 * client of the eve channel; the mirror is failsafe by construction.
 */
export default defineHook({
  events: {
    "*": (event, ctx) => {
      mirrorStreamEvent(ctx.session.id, event);
    },
  },
});
