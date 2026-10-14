"use client";

import { CameraIcon } from "lucide-react";
import { Card, failureLines, statePill } from "@/components/ai-elements/agent-cards";
import { cn } from "@/lib/utils";

/**
 * 0035: the attach_screenshot part — QA evidence (before/after previews,
 * error states) renders in the conversation instead of living and dying
 * with the sandbox's /tmp. A successful shot is an inline figure at its own
 * size; running/failed calls keep the tool card.
 */

interface ScreenshotView {
  path?: string;
  label?: string;
  url?: string;
  width?: number;
  height?: number;
  bytes?: number;
}

export function ScreenshotCard({
  state,
  input,
  output,
  errorText,
  className,
}: {
  state: string;
  input: unknown;
  output?: unknown;
  errorText?: string;
  className?: string;
}) {
  const result = output as { ok?: boolean; url?: string; width?: number; height?: number; bytes?: number } | undefined;
  const view = (input as ScreenshotView | undefined) ?? undefined;
  const failed = result ? result.ok === false : state === "output-error";
  const toolState: "running" | "completed" | "error" =
    state === "input-streaming" || state === "input-available" ? "running" : failed ? "error" : "completed";
  const { tone, pill: stateLabel } = statePill(toolState, failed);
  const ok = result?.ok === true;
  const dims = ok && result?.width && result?.height ? `${result.width}×${result.height}` : null;
  const size = ok && result?.bytes ? `${(result.bytes / 1024).toFixed(0)} KiB` : null;
  const caption = view?.label ?? view?.path;

  // A good screenshot is a message part, not a card: a caption and the image
  // at its own size (never stretched to the transcript's width).
  if (ok && result?.url) {
    return (
      <figure className={cn("not-prose my-2 flex w-fit max-w-full flex-col gap-1.5", className)}>
        <figcaption className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <CameraIcon className="size-3.5 shrink-0" aria-hidden />
          {caption && <span className="min-w-0 truncate">{caption}</span>}
          {(dims || size) && (
            <span className="shrink-0 font-mono text-[10px]">{[dims, size].filter(Boolean).join(" · ")}</span>
          )}
        </figcaption>
        <a href={result.url} target="_blank" rel="noreferrer" className="block w-fit max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element -- static attachment file served by our API, not the image optimizer */}
          <img
            src={result.url}
            alt={caption ?? "attached screenshot"}
            className="block h-auto max-h-[420px] w-auto max-w-full rounded-md border border-border bg-background"
          />
        </a>
      </figure>
    );
  }

  // Running or failed: no image yet, so the tool card.
  return (
    <Card
      icon={CameraIcon}
      title="Screenshot"
      subtitle={caption}
      tone={tone}
      pill={failed ? "failed" : toolState === "running" ? stateLabel : "attached"}
      failed={failed}
      errorLines={failureLines(output, errorText)}
      className={className}
    />
  );
}
