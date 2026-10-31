import { AppHeader } from "@/components/app-header";
import { PageContextRegistration } from "@/components/page-context";
import { ConnectorCards } from "@/components/settings/connector-cards";
import { GitCredentials } from "@/components/settings/git-credentials";
import { db } from "@/db";
import { buildConnectors } from "@/lib/settings/connectors";

export const dynamic = "force-dynamic";

/**
 * 0090 §2: every account the app uses as a connector card (status a
 * value shape, one [Test] live check each), plus the git credential
 * editor below — the card is a frame over flows that already exist.
 */
export default async function SettingsConnectionsPage() {
  const rows = await buildConnectors(db());
  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col overflow-y-auto">
      <PageContextRegistration value={{ kind: "other" }} />
      <AppHeader crumbs={[{ label: "Settings", href: "/settings" }, { label: "Connections" }]} />
      <div className="flex flex-col gap-8 p-4 md:p-6">
        <ConnectorCards rows={rows} />
        <GitCredentials />
      </div>
    </div>
  );
}
