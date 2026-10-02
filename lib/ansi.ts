/**
 * Minimal ANSI → styled-segments parser for terminal-style output.
 * Understands SGR colour/bold/dim (the 8 base + bright colours; 256/
 * truecolor params are consumed and ignored), drops every other escape
 * sequence, and collapses carriage-return progress redraws to the last
 * frame. Colours come back as names — callers map them to theme tokens.
 */

export type AnsiColor = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "gray";

export interface AnsiSegment {
  text: string;
  color?: AnsiColor;
  bold?: boolean;
  dim?: boolean;
}

const BASE: AnsiColor[] = ["gray", "red", "green", "yellow", "blue", "magenta", "cyan", "gray"];

const SGR = /\x1b\[([0-9;]*)m/g;
const OTHER_ESCAPES = /\x1b(?:\[[0-9;?]*[A-Za-ln-z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

/** Strip every escape sequence — plain text for copy/measure. */
export function stripAnsi(text: string): string {
  return text.replace(SGR, "").replace(OTHER_ESCAPES, "");
}

/** One array of segments per output line. */
export function parseAnsi(raw: string): AnsiSegment[][] {
  const text = raw.replace(OTHER_ESCAPES, "").replace(/\r\n/g, "\n");
  const lines: AnsiSegment[][] = [];
  let color: AnsiColor | undefined;
  let bold = false;
  let dim = false;

  for (const rawLine of text.split("\n")) {
    // A progress bar redraws with \r — only the last frame survives.
    const line = rawLine.includes("\r") ? rawLine.slice(rawLine.lastIndexOf("\r") + 1) : rawLine;
    const segments: AnsiSegment[] = [];
    let last = 0;
    const push = (chunk: string) => {
      if (chunk) segments.push({ text: chunk, ...(color && { color }), ...(bold && { bold }), ...(dim && { dim }) });
    };
    for (const match of line.matchAll(SGR)) {
      push(line.slice(last, match.index));
      last = match.index + match[0].length;
      const params = match[1] === "" ? [0] : match[1].split(";").map((n) => Number(n) || 0);
      for (let i = 0; i < params.length; i += 1) {
        const p = params[i];
        if (p === 0) {
          color = undefined;
          bold = false;
          dim = false;
        } else if (p === 1) bold = true;
        else if (p === 2) dim = true;
        else if (p === 22) {
          bold = false;
          dim = false;
        } else if (p === 39) color = undefined;
        else if (p >= 30 && p <= 37) color = BASE[p - 30];
        else if (p >= 90 && p <= 97) color = BASE[p - 90] === "gray" ? "gray" : BASE[p - 90];
        else if (p === 38 || p === 48) {
          // 38;5;n or 38;2;r;g;b — skip the operands, keep default colour.
          i += params[i + 1] === 5 ? 2 : params[i + 1] === 2 ? 4 : 0;
        }
      }
    }
    push(line.slice(last));
    lines.push(segments);
  }
  return lines;
}
