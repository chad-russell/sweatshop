/**
 * Clip helpers shared by every tool result (one module; was seven
 * hand-rolled copies — forgejo, gh, inspect, bash, web-search, previews,
 * pr-preview each carried its own). Four shapes cover every use:
 *
 *  - `clipEnds`   head + tail, middle dropped (command output)
 *  - `clipHead`   keep the head (API responses, messages, snippets)
 *  - `clipTail`   keep the tail (logs, where the end matters)
 *  - `clipLines`  keep the first N lines (summaries)
 *
 * Not here: wake.ts's `clipText` (pointer-aware, domain logic),
 * harness-events' value clip (unknown → JSON contract), child-status's
 * null-passthrough one-liner.
 */

/** Keep the head and tail of oversized output, dropping the middle. */
export function clipEnds(text: string, limit = 10_000): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n… [${text.length - limit} chars clipped] …\n${text.slice(-half)}`;
}

/** Keep the first `limit` characters (suffix says how much was dropped). */
export function clipHead(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} chars clipped]` : text;
}

/** Keep the last `limit` characters (a leading `…` marks the cut). */
export function clipTail(text: string, limit: number): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

/** Keep the first `max` lines; the suffix counts the rest. */
export function clipLines(text: string, max: number): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= max) return lines.join("\n");
  return `${lines.slice(0, max).join("\n")}\n… (+${lines.length - max} more)`;
}
