"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * 0040: a PAGE in the sidebar — a flat row that fills while its route is
 * active. Actions (New chat, Agent) are buttons instead and never take
 * this shape, so a row always means "navigate".
 */
export function NavRow({
  href,
  icon: Icon,
  label,
  active,
  children,
  className,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
  /** Right-aligned extras (badges). */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2 py-1.5 pointer-coarse:py-2.5 text-sm transition-colors hover:bg-sidebar-accent/60",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
        className,
      )}
    >
      <Icon className={cn("size-4 shrink-0", active ? "text-sidebar-accent-foreground" : "text-sidebar-foreground/60")} />
      <span className="flex-1 truncate">{label}</span>
      {children}
    </Link>
  );
}
