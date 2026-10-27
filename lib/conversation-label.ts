/** Pure display-label helpers for conversations (no db import). */

const LABEL_MAX = 60;

/** Strip `[tool <name>]` placeholder tokens (textOf's stand-in for a
 *  tool-call with no text) and surrounding whitespace. */
export function stripToolPlaceholders(text: string): string {
  return text.replace(/\[tool [^\]]*\]/g, "").trim();
}

/** Tool names named by `[tool <name>]` placeholders, in order, deduped. */
export function placeholderToolNames(text: string): string[] {
  const names = [...text.matchAll(/\[tool ([^\]]*)\]/g)].map((m) => m[1]!.trim()).filter(Boolean);
  return [...new Set(names)];
}

function singleLine(text: string): string {
  return stripToolPlaceholders(text)
    .replace(/```[a-z]*/gi, " ")
    .replace(/[`*_#>~]+/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Title if set; else a clipped first-user-message; else "Untitled chat". */
export function conversationLabel(input: {
  title?: string | null;
  id?: string;
  firstUserText?: string | null;
}): string {
  const title = input.title?.trim();
  if (title) return title;
  const text = input.firstUserText ? singleLine(input.firstUserText) : "";
  if (text) return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1).trimEnd()}…` : text;
  return "Untitled chat";
}
