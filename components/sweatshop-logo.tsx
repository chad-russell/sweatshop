import { cn } from "@/lib/utils";

/** Night shift, tinted by the caller's semantic text color. */
export function SweatshopLogo({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-6 shrink-0 bg-current mask-[url('/logo.svg')] mask-contain mask-center mask-no-repeat",
        className,
      )}
    />
  );
}
