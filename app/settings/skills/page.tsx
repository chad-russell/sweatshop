import { AppHeader } from "@/components/app-header";
import { PageContextRegistration } from "@/components/page-context";
import { SkillsStatusCard } from "@/components/settings/skills-status-card";

export const dynamic = "force-dynamic";

/** 0090 §1: /settings/skills — the 0088 status card, moved verbatim; phase 3 replaces it with the catalog. */
export default function SettingsSkillsPage() {
  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col overflow-y-auto">
      <PageContextRegistration value={{ kind: "other" }} />
      <AppHeader crumbs={[{ label: "Settings", href: "/settings" }, { label: "Skills" }]} />
      <div className="p-4 md:p-6">
        <SkillsStatusCard />
      </div>
    </div>
  );
}
