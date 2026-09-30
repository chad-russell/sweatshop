import { defineAgent, defineDynamic } from "eve";
import { createZhipu } from "zhipu-ai-provider";

/**
 * Z.AI GLM coding plan on the Anthropic-compatible coding endpoint.
 * Credentials come from ZAI_API_KEY (.env.local, passed by ./dev).
 */
const zai = createZhipu({
  apiKey: process.env.ZAI_API_KEY ?? "",
  baseURL: "https://api.z.ai/api/coding/paas/v4",
});

const DEFAULT_MODEL = "glm-5.3-flash";
/** GLM flash on the coding plan: 128k context. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * The resolver is deliberately static today but wired through
 * defineDynamic at step scope for two reasons:
 * - zhipu models are not in the AI Gateway catalog, so eve cannot resolve
 *   the context window itself — compaction sizing needs the explicit
 *   modelContextWindowTokens only a selection object can carry;
 * - the per-conversation model picker (the first post-MVP feature) grows
 *   into exactly this seam.
 */
export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": () => ({
        model: zai(DEFAULT_MODEL),
        modelContextWindowTokens: DEFAULT_CONTEXT_WINDOW,
      }),
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
