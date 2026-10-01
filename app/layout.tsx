import type { Metadata } from "next";
import { ConversationSidebar } from "@/components/conversation-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { db } from "@/db";
import { loadSidebar, purgeExpiredTrash } from "@/db/organize";
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
  purgeExpiredTrash(db());
  const data = loadSidebar(db());

  return (
    <html lang="en" suppressHydrationWarning className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          <TooltipProvider>
            <div className="flex h-dvh w-full">
              <ConversationSidebar data={data} />
              {/* max-md gutter reserves the strip the floating sidebar
                  trigger lives in (fixed top-left), on every page. */}
              <main className="h-dvh min-w-0 flex-1 max-md:pl-12">{children}</main>
            </div>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
