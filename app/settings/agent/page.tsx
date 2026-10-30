import { AppHeader } from "@/components/app-header";
import { PageContextRegistration } from "@/components/page-context";
import { AgentSettings } from "@/components/settings/agent-settings";

export const dynamic = "force-dynamic";

/** 0090 §1: /settings/agent — the prompt sections, moved verbatim. */
export default function SettingsAgentPage() {
  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col overflow-y-auto">
      <PageContextRegistration value={{ kind: "other" }} />
      <AppHeader crumbs={[{ label: "Settings", href: "/settings" }, { label: "Agent" }]} />
      <div className="p-4 md:p-6">
        <AgentSettings />
      </div>
    </div>
  );
}
