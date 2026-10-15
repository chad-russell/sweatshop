"use client";

import type { FileUIPart } from "ai";
import { PlusIcon, XIcon } from "lucide-react";
import {
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputHeader,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE } from "@/lib/attachment-ref";
import { cn } from "@/lib/utils";

/**
 * 0042: the composer's image affordances — the `+` menu and the thumbnail
 * row — built on the AI Elements attachment state (paste, drop and the
 * hidden file input already live in PromptInput). Images live in memory
 * (blob URLs) until a send uploads them.
 */

/** User-facing text for PromptInput's validation errors. */
export function attachmentErrorMessage(code: "max_files" | "max_file_size" | "accept"): string {
  switch (code) {
    case "accept":
      return "Only images (PNG, JPEG, WebP or GIF) can be attached.";
    case "max_file_size":
      return `Images must be under ${MAX_IMAGE_BYTES / 1024 / 1024} MiB.`;
    case "max_files":
      return `Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`;
  }
}

/** The `+` button: a menu with "Add photos" (the OS offers camera and
 *  library on a phone). Disabled while a turn runs — images cannot steer. */
export function ComposerAddButton({ disabled }: { disabled?: boolean }) {
  return (
    <PromptInputActionMenu>
      <PromptInputActionMenuTrigger
        aria-label="Add photos"
        title={disabled ? "Wait for the turn to finish to add images" : "Add photos"}
        disabled={disabled}
        className="rounded-full pointer-coarse:size-10"
      >
        <PlusIcon className="size-4" />
      </PromptInputActionMenuTrigger>
      <PromptInputActionMenuContent className="max-w-[calc(100vw-1rem)]">
        <PromptInputActionAddAttachments label="Add photos" />
      </PromptInputActionMenuContent>
    </PromptInputActionMenu>
  );
}

/** 64 px thumbnails above the text, each with a corner `×`. The `×` fades
 *  in on hover and keyboard focus; on touch there is no hover, so it is
 *  always visible with a 44 px hit area. */
export function ComposerAttachments({ dimmed }: { dimmed?: boolean }) {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <PromptInputHeader className="composer-attachments w-full gap-2">
      {attachments.files.map((file: FileUIPart & { id: string }) => (
        <div
          key={file.id}
          className={cn("group/thumb relative size-16 shrink-0 transition-opacity", dimmed && "opacity-50")}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
          <img
            src={file.url}
            alt={file.filename ?? "attached image"}
            className="size-full rounded-xl border border-border object-cover"
          />
          <button
            type="button"
            aria-label={`Remove ${file.filename ?? "image"}`}
            disabled={dimmed}
            onClick={() => attachments.remove(file.id)}
            className={cn(
              "absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm",
              "opacity-0 transition-opacity group-hover/thumb:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
              // Bigger touch target without a bigger visual.
              "before:absolute before:-inset-3 before:content-['']",
            )}
          >
            <XIcon className="size-3" aria-hidden />
          </button>
        </div>
      ))}
    </PromptInputHeader>
  );
}
