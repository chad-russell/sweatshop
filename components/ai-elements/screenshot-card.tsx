"use client";

import { CameraIcon } from "lucide-react";
import { Card, failureLines, statePill } from "@/components/ai-elements/agent-cards";
import { cn } from "@/lib/utils";

/**
 * 0035: the attach_screenshot card — the image IS the body. QA evidence
 * (before/after previews, error states) renders in the conversation
 * instead of living and dying with the sandbox's /tmp.
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
  return (
    <Card
      icon={CameraIcon}
      title="Screenshot"
      subtitle={view?.label ?? view?.path}
      tone={tone}
      pill={failed ? "failed" : toolState === "running" ? stateLabel : dims ?? "attached"}
      failed={failed}
      errorLines={failureLines(output, errorText)}
      defaultOpen={!failed}
      className={className}
    >
      {ok && result?.url && (
        <a href={result.url} target="_blank" rel="noreferrer" className="block">
          {/* eslint-disable-next-line @next/next/no-img-element -- static attachment file served by our API, not the image optimizer */}
          <img
            src={result.url}
            alt={view?.label ?? "attached screenshot"}
            className={cn(
              "max-h-[420px] w-full border-t border-border object-contain object-left-top",
              "bg-[repeating-conic-gradient(var(--color-border)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]",
            )}
          />
        </a>
      )}
      {(dims || size) && (
        <div className="border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
          {[dims, size].filter(Boolean).join(" · ")}
        </div>
      )}
    </Card>
  );
}
