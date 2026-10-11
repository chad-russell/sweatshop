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
import { NavTrigger } from "@/components/sidebar/nav-drawer";
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
        // Mobile: menu trigger + breadcrumb on row one, the page's
        // controls scroll sideways on row two. md+: one 56px row.
        "flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b py-2 pr-3 pl-1.5 md:h-14 md:flex-nowrap md:justify-between md:gap-3 md:px-4 md:py-0",
        className,
      )}
    >
      <NavTrigger />
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
      {children && (
        <div className="no-scrollbar -mx-1.5 flex w-full min-w-0 items-center gap-2 overflow-x-auto px-1.5 pb-0.5 max-md:order-last md:mx-0 md:w-auto md:shrink-0 md:overflow-visible md:px-0 md:pb-0 [&>*]:shrink-0">
          {children}
        </div>
      )}
    </header>
  );
}
