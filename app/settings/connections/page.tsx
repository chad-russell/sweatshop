import { AppHeader } from "@/components/app-header";
import { PageContextRegistration } from "@/components/page-context";
import { GitCredentials } from "@/components/settings/git-credentials";

export const dynamic = "force-dynamic";

/** 0090 §1: /settings/connections — git credentials today; §2's connector cards land in phase 2. */
export default function SettingsConnectionsPage() {
  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col overflow-y-auto">
      <PageContextRegistration value={{ kind: "other" }} />
      <AppHeader crumbs={[{ label: "Settings", href: "/settings" }, { label: "Connections" }]} />
      <div className="p-4 md:p-6">
        <GitCredentials />
      </div>
    </div>
  );
}
