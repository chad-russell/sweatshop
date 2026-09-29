import type { Metadata } from "next";
import { desc } from "drizzle-orm";
import {
  ConversationSidebar,
  type SidebarItem,
} from "@/components/conversation-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import "./globals.css";

export const metadata: Metadata = {
  title: "sweatshop",
  description: "A dynamic workspace around an eve agent.",
};

// The shell reads the conversation store on every request.
export const dynamic = "force-dynamic";

function recentConversations(): SidebarItem[] {
  return (
    db()
      .select({
        id: conversations.id,
        title: conversations.title,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .orderBy(desc(conversations.updatedAt))
      .limit(50)
      .all()
  );
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const items = await recentConversations();

  return (
    <html lang="en" suppressHydrationWarning className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          <TooltipProvider>
            <div className="flex h-dvh w-full">
              <ConversationSidebar items={items} />
              <main className="h-dvh min-w-0 flex-1">{children}</main>
            </div>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
