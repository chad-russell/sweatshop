import type { Metadata } from "next";
import { ConversationSidebar } from "@/components/conversation-sidebar";
import { PageContextProvider } from "@/components/page-context";
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
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          <TooltipProvider>
            {/* 0015: pages register what they are; the agent panel reads
                it at send time. Covers the main column and the panel. */}
            <PageContextProvider>
              <div className="flex h-dvh w-full">
                <ConversationSidebar
                  data={data}
                  inbox={{
                    signature: attention.signature,
                    unread: attention.unread.size,
                    needsYou: attention.needsYou.size,
                  }}
                />
                {/* max-md gutter reserves the strip the floating sidebar
                    trigger lives in (fixed top-left), on every page. */}
                <main className="h-dvh min-w-0 flex-1 max-md:pl-12">{children}</main>
              </div>
            </PageContextProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
