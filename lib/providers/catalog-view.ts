import type { Db } from "../../db";
import { getGlobalDefaults, getProjectModels, listProviderModels, type ProjectModels } from "../../db/providers";
import { cursorConfigured, cursorCredential } from "../harness-auth/cursor";
import { codexConfigured, codexCredential } from "../harness-auth/codex";
import { CLAUDE_MODELS, CODEX_MODELS, CURSOR_MODELS, PROVIDER_IDS, PROVIDER_LABELS, type ModelInfo, type ProviderId } from "./catalog";
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
  /** 0038: `configured` = a usable login file; `status` is the reason it
   *  is not (missing/invalid/expired), `expiresAt` the access-token expiry. */
  cursor: {
    configured: boolean;
    allowed: boolean;
    models: { id: string; label: string }[];
    status: string | null;
    expiresAt: number | null;
  };
  /** 0050: same shape as cursor plus `accountId` — the enterprise
   *  workspace id the builder forwards as ChatGPT-Account-ID (null for
   *  personal logins). */
  codex: {
    configured: boolean;
    allowed: boolean;
    models: { id: string; label: string }[];
    status: string | null;
    expiresAt: number | null;
    accountId: string | null;
  };
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
    cursor: cursorView(harnessAllowed("cursor")),
    codex: codexView(harnessAllowed("codex")),
    piAllowed: harnessAllowed("pi"),
    defaults: getGlobalDefaults(db),
    project,
  };
}

function cursorView(allowed: boolean): ModelsView["cursor"] {
  const credential = cursorCredential();
  return {
    configured: cursorConfigured(),
    allowed,
    models: [...CURSOR_MODELS],
    status: credential.ok ? null : credential.message,
    expiresAt: credential.ok ? credential.expiresAt : null,
  };
}

function codexView(allowed: boolean): ModelsView["codex"] {
  const credential = codexCredential();
  return {
    configured: codexConfigured(),
    allowed,
    models: [...CODEX_MODELS],
    status: credential.ok ? null : credential.message,
    expiresAt: credential.ok ? credential.expiresAt : null,
    accountId: credential.ok ? credential.accountId : null,
  };
}
