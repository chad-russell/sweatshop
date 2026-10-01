import { FolderGit2, MessageSquare } from "lucide-react";
import { relativeTime } from "@/components/sidebar/types";

/** "project › Folder › Sub" breadcrumb + age, shared by every inbox card. */
export function Where({
  projectName,
  path,
  at,
}: {
  projectName: string | null;
  path: readonly string[];
  at: number;
}) {
  const Icon = projectName ? FolderGit2 : MessageSquare;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{[projectName ?? "Chats", ...path].join(" › ")}</span>
      <span aria-hidden>·</span>
      <time className="shrink-0 font-mono" dateTime={new Date(at).toISOString()}>
        {relativeTime(at)}
      </time>
    </span>
  );
}
