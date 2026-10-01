"use client";

import { useState, type DragEvent } from "react";
import { useSidebar } from "./context";
import type { Drag } from "./types";

export interface DropTarget {
  projectId: string | null;
  /** Destination folder; null = the group's top level (Inbox / root). */
  folderId: string | null;
  /** Restrict to one drag kind (the Inbox takes conversations only). */
  only?: Drag["kind"];
}

/**
 * Client mirror of the store's invariants (db/organize.ts) — same group
 * only, no folder into its own subtree, and no-op drops are not offered.
 * The server re-checks everything; this only decides what looks droppable.
 */
export function canDrop(drag: Drag, target: DropTarget): boolean {
  if (target.only && drag.kind !== target.only) return false;
  if (drag.projectId !== target.projectId) return false;
  if (drag.kind === "conversation") return drag.folderId !== target.folderId;
  if (target.folderId !== null && drag.subtree.has(target.folderId)) return false;
  return drag.parentId !== target.folderId;
}

/** Native HTML5 drop target wiring for one folder / group-root element. */
export function useDropTarget(target: DropTarget) {
  const { drag, setDrag, actions } = useSidebar();
  const [over, setOver] = useState(false);
  const allowed = drag !== null && canDrop(drag, target);

  const props = {
    onDragOver: (e: DragEvent) => {
      if (!allowed) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!over) setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setOver(false);
    },
    onDrop: (e: DragEvent) => {
      setOver(false);
      if (!drag || !allowed) return;
      e.preventDefault();
      e.stopPropagation();
      const dragged = drag;
      setDrag(null);
      if (dragged.kind === "conversation") {
        void actions.moveConversation(dragged.id, target.folderId);
      } else {
        void actions.moveFolder(dragged.id, target.folderId);
      }
    },
  };

  return {
    props,
    /** Highlight: a valid drag is hovering this target. */
    over: over && allowed,
    /** Dim: something is being dragged and cannot be dropped here. */
    dimmed: drag !== null && !allowed,
  };
}
