import { createZhipu } from "zhipu-ai-provider";

/**
 * Shared model factory (0004 Path B): the same GLM coding-plan endpoint
 * the eve agent uses, for raw WorkflowAgent phases.
 */
export function glmFlash() {
  return createZhipu({
    apiKey: process.env.ZAI_API_KEY ?? "",
    baseURL: "https://api.z.ai/api/coding/paas/v4",
  })("glm-5.3-flash");
}
