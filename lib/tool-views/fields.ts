/**
 * Read fields out of a tool call's recorded input/output. harness_events
 * clips long values, and a clipped JSON string no longer parses — so
 * `field` falls back to a regexp that recovers (and flags) a string value
 * cut off mid-way.
 */

export interface Field {
  value: string;
  /** The value was cut off by the recorder's clip. */
  clipped: boolean;
}

const CLIP_MARK = "…";

export function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function unescapeJson(raw: string): string {
  // A clip can land mid-escape (`\` or `\u12`), so retry with it trimmed.
  for (const attempt of [raw, raw.replace(/\\$/, ""), raw.replace(/\\u[0-9a-fA-F]{0,3}$/, "")]) {
    try {
      return JSON.parse(`"${attempt}"`) as string;
    } catch {
      /* try the next */
    }
  }
  return raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** First of `keys` present as a string in `input` (object or JSON text,
 *  possibly clipped). */
export function field(input: unknown, ...keys: string[]): Field | undefined {
  const obj = objectOf(input);
  if (obj) {
    for (const key of keys) {
      if (typeof obj[key] === "string") return { value: obj[key] as string, clipped: false };
    }
    return undefined;
  }
  if (typeof input !== "string") return undefined;
  for (const key of keys) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)("?)`).exec(input);
    if (!m) continue;
    const closed = m[2] === '"';
    let raw = m[1]!;
    if (!closed && raw.endsWith(CLIP_MARK)) raw = raw.slice(0, -1);
    return { value: unescapeJson(raw), clipped: !closed };
  }
  return undefined;
}

/** A number field from an object/JSON input. */
export function numberField(input: unknown, key: string): number | undefined {
  const value = objectOf(input)?.[key];
  return typeof value === "number" ? value : undefined;
}
