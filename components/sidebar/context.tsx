"use client";

import { createContext, useContext } from "react";
import type { Drag, Editing } from "./types";
import type { SidebarActions } from "./use-actions";

export interface SidebarContextValue {
  actions: SidebarActions;
  pathname: string;
  /** False during SSR/hydration: gate anything timezone/clock dependent. */
  mounted: boolean;
  collapsed: ReadonlySet<string>;
  toggleFolder: (id: string) => void;
  /** 0040 phase 2: explicit open/closed choices for parent conversation
   *  rows (tri-state — absence means "use the computed default"). */
  threadExpanded: ReadonlyMap<string, boolean>;
  setThreadExpanded: (id: string, expanded: boolean) => void;
  editing: Editing | null;
  setEditing: (editing: Editing | null) => void;
  drag: Drag | null;
  setDrag: (drag: Drag | null) => void;
}

export const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const value = useContext(SidebarContext);
  if (!value) throw new Error("useSidebar must be used inside the sidebar");
  return value;
}
