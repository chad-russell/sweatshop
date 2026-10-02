import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";

export interface Crumb {
  /** Rendered content; the last crumb is the current page. */
  label: ReactNode;
  /** Ancestors link up the tree; the current page has none. */
  href?: string;
  /** Machine-voice (identifiers) renders mono per DESIGN.md rule 4. */
  mono?: boolean;
}

/**
 * The one top bar for conversation-shaped pages (chat, harness
 * sessions): where-am-I on the left as a breadcrumb — every ancestor is
 * a link, so a sub-conversation always has a way back to its parent —
 * and that page's own controls/status on the right. Page-level
 * chrome that isn't about this page (new chat, theme) lives in the
 * sidebar, not here.
 */
export function AppHeader({
  crumbs,
  children,
  className,
}: {
  crumbs: readonly Crumb[];
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4",
        className,
      )}
    >
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap">
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1;
            const body = (
              <span className={cn("block truncate", crumb.mono && "font-mono text-[13px]")}>
                {crumb.label}
              </span>
            );
            return (
              <Fragment key={i}>
                <BreadcrumbItem className={cn("min-w-0", last ? "shrink" : "shrink-[3]")}>
                  {last || !crumb.href ? (
                    <BreadcrumbPage className="min-w-0 font-medium">{body}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild className="min-w-0">
                      <Link href={crumb.href}>{body}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {!last && <BreadcrumbSeparator className="shrink-0" />}
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  );
}
