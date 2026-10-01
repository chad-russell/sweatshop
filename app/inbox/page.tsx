import { InboxView } from "@/components/inbox/inbox-view";
import { db } from "@/db";
import { loadInbox } from "@/db/attention";

export const dynamic = "force-dynamic";

/** 0008: everything waiting on you — pending asks, then unread threads. */
export default function InboxPage() {
  return <InboxView data={loadInbox(db())} />;
}
