import { ChatSurface } from "@/components/chat";

/**
 * Chats home: a new unbound conversation — or, with the composer's
 * target set to a machine (0012; `?machine=<id>` preselects one), a
 * workspace-free machine run.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ machine?: string }>;
}) {
  const { machine } = await searchParams;
  return <ChatSurface key={machine ?? "chat"} initialMachineId={machine ?? null} />;
}
