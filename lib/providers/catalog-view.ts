import type { Db } from "../../db";
import { getGlobalDefaults, getProjectModels, listProviderModels, type ProjectModels } from "../../db/providers";
import { CLAUDE_MODELS, PROVIDER_IDS, PROVIDER_LABELS, type ModelInfo, type ProviderId } from "./catalog";
import { availableProviders } from "./registry";
import type { GlobalDefaults, RouteHarness } from "./route";

/**
 * 0021: what a model picker may offer — JSON for `GET /api/models` and
 * server-rendered pages. Unavailable providers are listed (so /settings
 * can say "key not set") but carry no models; inside a restricted
 * project only allowed providers/harnesses appear.
 */
export interface ModelsView {
  providers: {
    id: ProviderId;
    label: string;
    available: boolean;
    /** Allowed by the project (always true without a project). */
    allowed: boolean;
    models: ModelInfo[];
  }[];
  claude: { configured: boolean; allowed: boolean; models: { id: string; label: string }[] };
  piAllowed: boolean;
  defaults: GlobalDefaults;
  project: ProjectModels | null;
}

export function modelsView(db: Db, projectId?: string | null): ModelsView {
  const available = availableProviders();
  const project = getProjectModels(db, projectId);
  const harnessAllowed = (h: RouteHarness) => !project?.allowedHarnesses || project.allowedHarnesses.includes(h);
  return {
    providers: PROVIDER_IDS.map((id) => {
      const isAvailable = available.has(id);
      return {
        id,
        label: PROVIDER_LABELS[id],
        available: isAvailable,
        allowed: !project?.allowedProviders || project.allowedProviders.includes(id),
        models: isAvailable ? listProviderModels(db, id) : [],
      };
    }),
    claude: {
      configured: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
      allowed: harnessAllowed("claude"),
      models: [...CLAUDE_MODELS],
    },
    piAllowed: harnessAllowed("pi"),
    defaults: getGlobalDefaults(db),
    project,
  };
}
