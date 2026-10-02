import { InboxView } from "@/components/inbox/inbox-view";
import { PageContextRegistration } from "@/components/page-context";
import { db } from "@/db";
import { loadInbox } from "@/db/attention";

export const dynamic = "force-dynamic";

/** 0008: everything waiting on you — pending asks, then unread threads. */
export default function InboxPage() {
  return (
    <>
      {/* 0015: the panel's "this" on the inbox. */}
      <PageContextRegistration value={{ kind: "inbox" }} />
      <InboxView data={loadInbox(db())} />
    </>
  );
}
