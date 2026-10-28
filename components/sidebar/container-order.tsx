"use client";

import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useState, type DragEvent } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { insertRelative } from "@/lib/sidebar-organization";
import { useSidebar } from "./context";
import type { Drag } from "./types";
import type { useDropTarget } from "./use-drop-target";

export interface ContainerOrder {
  id: string;
  scope: string;
  ids: readonly string[];
  projectId: string | null;
  parentId?: string | null;
  kind: "group" | "folder";
}

/** Edge drops reorder siblings; a folder's body still files/reparents. */
export function useContainerOrder(order: ContainerOrder, body: ReturnType<typeof useDropTarget>["props"]) {
  const { drag, setDrag, setOrder } = useSidebar();
  const [edge, setEdge] = useState<"before" | "after" | null>(null);
  const eligible = drag?.kind === order.kind && drag.id !== order.id && order.ids.includes(drag.id) &&
    (drag.kind !== "folder" || (drag.projectId === order.projectId && drag.parentId === order.parentId));
  const getEdge = (e: DragEvent): "before" | "after" | null => {
    if (!eligible) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (order.kind === "group") return y < rect.height / 2 ? "before" : "after";
    return y < 8 ? "before" : y > rect.height - 8 ? "after" : null;
  };
  return {
    indicator: eligible && edge && (edge === "before"
      ? "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:border-t-2 before:border-sidebar-ring"
      : "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:border-b-2 after:border-sidebar-ring"),
    props: {
      onDragOver(e: DragEvent) {
        const next = getEdge(e);
        setEdge(next);
        if (next) {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
        } else body.onDragOver(e);
      },
      onDragLeave(e: DragEvent) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEdge(null);
        body.onDragLeave(e);
      },
      onDrop(e: DragEvent) {
        const next = getEdge(e);
        setEdge(null);
        if (next && drag) {
          e.preventDefault();
          e.stopPropagation();
          setOrder(order.scope, insertRelative(order.ids, drag.id, order.id, next));
          setDrag(null);
        } else body.onDrop(e);
      },
    },
  };
}

export function OrderHandle({ label, drag }: { label: string; drag: Drag }) {
  const { setDrag } = useSidebar();
  return (
    <span
      draggable
      role="img"
      aria-label={`Drag to reorder ${label}`}
      title="Drag to reorder; or use Move up / Move down in the actions menu"
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.setData("text/plain", drag.id);
        e.dataTransfer.effectAllowed = "move";
        setDrag(drag);
      }}
      onDragEnd={() => setDrag(null)}
      className="inline-flex w-3 shrink-0 cursor-grab items-center justify-center text-sidebar-foreground/40 opacity-0 transition-opacity active:cursor-grabbing group-hover/head:opacity-100 group-focus-within/head:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:hidden"
    >
      <GripVertical className="size-3" />
    </span>
  );
}

export function OrderMenuItems({ id, scope, ids }: Pick<ContainerOrder, "id" | "scope" | "ids">) {
  const { setOrder } = useSidebar();
  const index = ids.indexOf(id);
  return (
    <>
      <DropdownMenuItem disabled={index <= 0} onSelect={() => setOrder(scope, insertRelative(ids, id, ids[index - 1], "before"))}>
        <ArrowUp /> Move up
      </DropdownMenuItem>
      <DropdownMenuItem disabled={index < 0 || index >= ids.length - 1} onSelect={() => setOrder(scope, insertRelative(ids, id, ids[index + 1], "after"))}>
        <ArrowDown /> Move down
      </DropdownMenuItem>
    </>
  );
}
