import { AppHeader } from "@/components/app-header";
import { ModelDefaults } from "@/components/settings/model-defaults";
import { db } from "@/db";
import { modelsView } from "@/lib/providers/catalog-view";
import { ensureOpenRouterCatalog } from "@/lib/providers/openrouter";

export const dynamic = "force-dynamic";

/** 0021 §6: settings — the per-surface default model routes. */
export default async function SettingsPage() {
  await ensureOpenRouterCatalog(db());
  const view = modelsView(db());
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-y-auto">
      <AppHeader crumbs={[{ label: "Settings" }]} />
      <div className="p-6">
        <ModelDefaults initial={view} />
      </div>
    </div>
  );
}
