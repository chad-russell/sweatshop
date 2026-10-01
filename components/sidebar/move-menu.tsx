"use client";

import { FolderInput } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import type { FolderChoice } from "./types";

/**
 * "Move to…" submenu — the keyboard and touch path for everything drag
 * and drop does. `currentId` (the current folder/parent) is disabled
 * because moving there would be a no-op.
 */
export function MoveMenu({
  rootLabel,
  currentId,
  choices,
  onPick,
}: {
  rootLabel: string;
  currentId: string | null;
  choices: readonly FolderChoice[];
  onPick: (folderId: string | null) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FolderInput />
        Move to…
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72 min-w-44 overflow-y-auto">
        <DropdownMenuItem
          disabled={currentId === null}
          onSelect={() => onPick(null)}
        >
          {rootLabel}
        </DropdownMenuItem>
        {choices.map((choice) => (
          <DropdownMenuItem
            key={choice.id}
            disabled={currentId === choice.id}
            style={{ paddingLeft: 6 + choice.depth * 12 }}
            onSelect={() => onPick(choice.id)}
          >
            <span className="truncate">{choice.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
