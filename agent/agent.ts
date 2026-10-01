import { defineAgent, defineDynamic } from "eve";
import { resolveChatModel, zaiModel } from "../lib/model";
import { sessionModelId } from "../lib/session-attributes";

/**
 * Per-conversation model selection: the channel lifts x-sweatshop-model
 * into the initiating principal's attributes (immutable for the
 * session's life, like the project binding), and this resolver reads it
 * at every model step. Unknown or missing ids resolve to the default.
 *
 * Kept at step scope (not session.started) because zhipu models are not
 * in the AI Gateway catalog — eve cannot resolve their context window,
 * so compaction sizing needs the explicit modelContextWindowTokens that
 * only a selection object (with a live LanguageModel) can carry. The
 * selection is constant for the session, so prompt caches are safe.
 */
export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        const model = resolveChatModel(sessionModelId(ctx.session));
        return {
          model: zaiModel(model.id),
          modelContextWindowTokens: model.contextWindowTokens,
        };
      },
    },
  }),
  // better-sqlite3 is a native addon; @ai-sdk/harness-claude-code loads
  // package-relative bridge assets (dist/bridge/*) via import.meta.url —
  // bundling either into the compiled runtime breaks them, so both stay
  // external (normal Node resolution, 0006).
  build: {
    externalDependencies: ["better-sqlite3", "@ai-sdk/harness-claude-code"],
  },
});
