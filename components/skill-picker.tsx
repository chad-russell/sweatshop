"use client";

import { BookOpen, CheckIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AttachableSkill } from "@/lib/api/skills-catalog";
import { MAX_ATTACHED_SKILLS } from "@/lib/skills/sources";
import { cn } from "@/lib/utils";

/**
 * 0091 §3: the composer's "Add skill…" picker (Command palette shape —
 * cmdk is already a dep). The attachable list arrives as props — the
 * owner (ChatSession) fetches it when the picker opens, cheap and fresh.
 * Manual- and tool-mode skills lead the list (they can ONLY join a chat
 * by attach); picking toggles a chip and keeps the dialog open so
 * several can ride one send (cap MAX_ATTACHED_SKILLS).
 */

export function SkillPicker({
  open,
  onOpenChange,
  skills,
  loading,
  attached,
  onToggle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skills: readonly AttachableSkill[];
  loading: boolean;
  attached: readonly string[];
  onToggle: (id: string) => void;
}) {
  const atCap = attached.length >= MAX_ATTACHED_SKILLS;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 overflow-hidden">
        <DialogHeader className="sr-only">
          <DialogTitle>Add skill to this message</DialogTitle>
          <DialogDescription>
            Choose up to {MAX_ATTACHED_SKILLS} skills — their full runbooks join this one message.
          </DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Search skills…" />
          <CommandList className="max-h-72">
            <CommandEmpty>{loading ? "Loading…" : "No skills match."}</CommandEmpty>
            {skills.map((skill) => {
              const chosen = attached.includes(skill.id);
              const blocked = !chosen && atCap;
              return (
                <CommandItem
                  key={skill.id}
                  value={skill.id}
                  keywords={[skill.description]}
                  disabled={blocked}
                  onSelect={() => onToggle(skill.id)}
                >
                  <BookOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-xs">{skill.id}</span>
                    <span className="text-muted-foreground"> — {skill.description}</span>
                  </span>
                  {skill.invoke !== "auto" && (
                    <span className="shrink-0 rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
                      {skill.invoke}
                    </span>
                  )}
                  <CheckIcon
                    className={cn("size-4 shrink-0", chosen ? "opacity-100" : "opacity-0")}
                    aria-hidden
                  />
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
        <DialogFooter className="border-t border-border px-3 py-2">
          <p className="mr-auto text-xs text-muted-foreground">
            {attached.length}/{MAX_ATTACHED_SKILLS} attached
            {atCap ? " — cap reached" : ""}
          </p>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The composer's chip row — attach state made visible before send.
 * Same slot as the image thumbnails (an attachment without bytes):
 * `id` in mono with the thumbnail row's corner-`×` treatment. */
export function AttachedSkillChips({
  ids,
  onRemove,
}: {
  ids: readonly string[];
  onRemove: (id: string) => void;
}) {
  if (ids.length === 0) return null;
  return (
    <div className="flex w-full flex-wrap gap-2 pt-1">
      {ids.map((id) => (
        <div key={id} className="group/chip relative">
          <span className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/50 px-2 py-1 font-mono text-xs text-muted-foreground">
            <BookOpen className="size-3 shrink-0" aria-hidden />
            {id}
          </span>
          <button
            type="button"
            aria-label={`Remove skill ${id}`}
            onClick={() => onRemove(id)}
            className={cn(
              "absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm",
              "opacity-0 transition-opacity group-hover/chip:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
              "before:absolute before:-inset-3 before:content-['']",
            )}
          >
            <XIcon className="size-3" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
