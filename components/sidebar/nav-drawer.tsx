"use client";

import { PanelLeft } from "lucide-react";
import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { cn } from "cn";

interface NavDrawer {
  /** Mobile drawer is open (it closes itself when the route changes). */
  open: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
}

const NavDrawerContext = createContext<NavDrawer | null>(null);

/**
 * Mobile navigation drawer state, shared by the sidebar (which renders the
 * drawer) and every page header (which renders the trigger). State is "the
 * pathname it was opened on", so a route change closes it without an
 * effect-driven setState.
 */
export function NavDrawerProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const value = useMemo<NavDrawer>(
    () => ({
      open: drawerPath !== null && drawerPath === pathname,
      openDrawer: () => setDrawerPath(pathname),
      closeDrawer: () => setDrawerPath(null),
    }),
    [drawerPath, pathname],
  );
  return <NavDrawerContext.Provider value={value}>{children}</NavDrawerContext.Provider>;
}

export function useNavDrawer(): NavDrawer {
  const ctx = useContext(NavDrawerContext);
  if (!ctx) throw new Error("useNavDrawer must be used inside NavDrawerProvider");
  return ctx;
}

/** The mobile-only menu button that lives at the start of a page header. */
export function NavTrigger({ className }: { className?: string }) {
  const { openDrawer } = useNavDrawer();
  return (
    <button
      type="button"
      aria-label="Open conversations"
      title="Conversations"
      onClick={openDrawer}
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden",
        className,
      )}
    >
      <PanelLeft className="size-5" aria-hidden />
    </button>
  );
}
