import type { Metadata, Viewport } from "next";
import { AgentPanel } from "@/components/agent-panel";
import { ConversationSidebar } from "@/components/conversation-sidebar";
import { PageContextProvider } from "@/components/page-context";
import { NewProjectDialog } from "@/components/project/new-project";
import { NavDrawerProvider } from "@/components/sidebar/nav-drawer";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { db } from "@/db";
import { loadAttention } from "@/db/attention";
import { loadSidebar, purgeExpiredTrash } from "@/db/organize";
import { destroyOwnedSandboxes } from "@/lib/sandboxes/binding";
import "./globals.css";

export const metadata: Metadata = {
  title: "sweatshop",
  description: "A dynamic workspace around an eve agent.",
};

// Mobile: `resizes-content` shrinks the dynamic viewport when the
// keyboard opens, so the composer stays above it instead of the page
// scrolling underneath.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

// The shell reads the conversation store on every request.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // 0007: lazy trash retention — the layout already reads the store on
  // every request, so expired trash is swept here (a cheap indexed-free
  // scan over a small table) instead of needing a scheduler.
  // 0013: purged runs' own sandboxes are destroyed in the background.
  void destroyOwnedSandboxes(purgeExpiredTrash(db()));
  const attention = loadAttention(db());
  const data = loadSidebar(db(), attention);

  return (
    <html lang="en" suppressHydrationWarning className="h-full antialiased">
      <body className="flex h-full flex-col">
        <ThemeProvider>
          <TooltipProvider>
            {/* 0015: pages register what they are; the agent panel reads
                it at send time. Covers the main column and the panel. */}
            <PageContextProvider>
              <NavDrawerProvider>
              <div className="flex h-dvh w-full">
                <ConversationSidebar
                  data={data}
                  inbox={{
                    signature: attention.signature,
                    unread: attention.unread.size,
                    needsYou: attention.needsYou.size,
                  }}
                />
                {/* The shell never scrolls (globals.css locks html/body);
                    each page owns its own scroll region. The mobile nav
                    trigger lives in AppHeader, not in a reserved gutter. */}
                <main className="h-dvh min-w-0 flex-1 overflow-y-auto overscroll-contain">
                  {children}
                </main>
                {/* 0015: the agent panel — an ordinary chat that follows
                    you across pages (pushes on lg+, overlays below). */}
                <AgentPanel />
                {/* 0040: the New-project dialog, opened by NEW_PROJECT_EVENT. */}
                <NewProjectDialog />
              </div>
              </NavDrawerProvider>
            </PageContextProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
