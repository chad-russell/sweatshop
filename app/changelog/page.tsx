import { AppHeader } from "@/components/app-header";
import { MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { loadChangelog } from "@/lib/changelog";

export const dynamic = "force-dynamic";

/** Known tags get a semantic color; an unrecognized/fallback tag stays neutral. */
const TAG_CLASS: Record<string, string> = {
  Added: "text-success",
  Changed: "text-info",
  Fixed: "text-warning",
};

function formatDateHeading(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(parsed);
}

/** 0085: what shipped, read from the repo-root CHANGELOG.md at request time. */
export default async function ChangelogPage() {
  const dates = loadChangelog();
  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col overflow-y-auto">
      <AppHeader crumbs={[{ label: "Changelog" }]} />
      <div className="flex flex-col gap-6 p-4 md:p-6">
        {dates.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing here yet.</p>
        ) : (
          dates.map((entry) => (
            <section key={entry.date} className="flex flex-col gap-2">
              <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {formatDateHeading(entry.date)}
              </h2>
              <ul className="flex flex-col gap-2">
                {entry.entries.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <Badge variant="outline" className={cn("mt-0.5 shrink-0 text-[10px]", TAG_CLASS[item.tag])}>
                      {item.tag}
                    </Badge>
                    <MessageResponse className="min-w-0 flex-1">{item.text}</MessageResponse>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
