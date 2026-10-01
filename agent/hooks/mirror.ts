import { defineHook } from "eve/hooks";
import { mirrorStreamEvent } from "../../db/mirror";
import { sessionProjectId } from "../../lib/session-attributes";
import { scheduleTitleGeneration } from "../../lib/titles";

/**
 * 0002/0004: mirror every durable stream event into sweatshop's sqlite
 * store (conversations index + append-only event log), stamping each
 * conversation's immutable project binding from the session's initiating
 * principal (x-sweatshop-project → channel auth attributes). Hooks
 * observe events after they are durably recorded and receive the full
 * envelope — meta.id is the idempotency key. This fires for sessions
 * from any client of the eve channel; the mirror is failsafe by
 * construction. Generated titles (0007) hang off message.completed.
 */
export default defineHook({
  events: {
    "*": (event, ctx) => {
      mirrorStreamEvent(ctx.session.id, event, {
        projectId: sessionProjectId(ctx.session),
      });
      // 0007: label the conversation after an assistant reply lands —
      // fire-and-forget, so the stream never waits on a model call.
      if (event.type === "message.completed") {
        scheduleTitleGeneration(ctx.session.id);
      }
    },
  },
});
