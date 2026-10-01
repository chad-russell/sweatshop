import { ChatSurface } from "@/components/chat";
import { StartRunButton } from "@/components/machines/start-run-button";

/** Chats home: a new unbound conversation, or a workspace-free machine run (0009). */
export default function Home() {
  return <ChatSurface headerExtra={<StartRunButton />} />;
}
