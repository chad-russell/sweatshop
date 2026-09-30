import type { Metadata } from "next";
import { desc } from "drizzle-orm";
import {
  ConversationSidebar,
  type SidebarGroup,
} from "@/components/conversation-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { db } from "@/db";
import { conversations, projects } from "@/db/schema";
import "./globals.css";

export const metadata: Metadata = {
  title: "sweatshop",
  description: "A dynamic workspace around an eve agent.",
};

// The shell reads the conversation store on every request.
export const dynamic = "force-dynamic";

/** Conversations grouped by project (0004 Phase C); unbound last. */
function sidebarGroups(): SidebarGroup[] {
  const projectRows = db()
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .all()
    .sort((a, b) => a.name.localeCompare(b.name));

  const conversationRows = db()
    .select({
      id: conversations.id,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
      projectId: conversations.projectId,
    })
    .from(conversations)
    .orderBy(desc(conversations.updatedAt))
    .limit(50)
    .all();

  const byProject = new Map<string, typeof conversationRows>();
  const unbound: typeof conversationRows = [];
  for (const row of conversationRows) {
    if (row.projectId) {
      const list = byProject.get(row.projectId) ?? [];
      list.push(row);
      byProject.set(row.projectId, list);
    } else {
      unbound.push(row);
    }
  }

  const groups: SidebarGroup[] = projectRows.map((project) => ({
    project: { id: project.id, name: project.name },
    items: (byProject.get(project.id) ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt,
    })),
  }));
  if (unbound.length > 0) {
    groups.push({
      project: null,
      items: unbound.map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updatedAt,
      })),
    });
  }
  return groups;
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const groups = sidebarGroups();

  return (
    <html lang="en" suppressHydrationWarning className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          <TooltipProvider>
            <div className="flex h-dvh w-full">
              <ConversationSidebar groups={groups} />
              <main className="h-dvh min-w-0 flex-1">{children}</main>
            </div>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
