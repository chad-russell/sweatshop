import { AppHeader } from "@/components/app-header";
import { PageContextRegistration } from "@/components/page-context";
import { ModelDefaults } from "@/components/settings/model-defaults";
import { db } from "@/db";
import { modelsView } from "@/lib/providers/catalog-view";
import { ensureOpenRouterCatalog } from "@/lib/providers/openrouter";
import { ensureModelPrices } from "@/lib/usage/prices-refresh";

export const dynamic = "force-dynamic";

/** 0090 §1: /settings/models — the per-surface default routes (0021 §6), moved verbatim. */
export default async function SettingsModelsPage() {
  await Promise.all([ensureOpenRouterCatalog(db()), ensureModelPrices(db())]);
  const view = modelsView(db());
  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col overflow-y-auto">
      <PageContextRegistration value={{ kind: "other" }} />
      <AppHeader crumbs={[{ label: "Settings", href: "/settings" }, { label: "Models" }]} />
      <div className="p-4 md:p-6">
        <ModelDefaults initial={view} />
      </div>
    </div>
  );
}
