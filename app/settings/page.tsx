import { AppHeader } from "@/components/app-header";
import { ModelDefaults } from "@/components/settings/model-defaults";
import { GitCredentials } from "@/components/settings/git-credentials";
import { AgentSettings } from "@/components/settings/agent-settings";
import { db } from "@/db";
import { modelsView } from "@/lib/providers/catalog-view";
import { ensureOpenRouterCatalog } from "@/lib/providers/openrouter";
import { ensureModelPrices } from "@/lib/usage/prices-refresh";

export const dynamic = "force-dynamic";

/** 0021 §6: settings — the per-surface default model routes. */
export default async function SettingsPage() {
  await Promise.all([ensureOpenRouterCatalog(db()), ensureModelPrices(db())]);
  const view = modelsView(db());
  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col overflow-y-auto">
      <AppHeader crumbs={[{ label: "Settings" }]} />
      <div className="p-4 md:p-6">
        <ModelDefaults initial={view} />
        <GitCredentials />
        <AgentSettings />
      </div>
    </div>
  );
}
