import { PageContextRegistration } from "@/components/page-context";
import { PRDashboard } from "@/components/prs/dashboard";
import { db } from "@/db";
import { loadPRDashboard } from "@/lib/prs/dashboard";

export const dynamic = "force-dynamic";

/**
 * 0053: every PR by Chad's accounts across project repos — asked live on
 * view, stored nothing (the 0052 philosophy); a refresh re-asks.
 */
export default async function PRsPage() {
  const data = await loadPRDashboard(db());
  return (
    <>
      {/* 0015: /prs is not a chat surface — the panel's "this" is just the page. */}
      <PageContextRegistration value={{ kind: "other" }} />
      <PRDashboard data={data} />
    </>
  );
}
