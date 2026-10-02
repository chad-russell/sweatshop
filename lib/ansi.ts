/**
 * ANSI → styled-segments parser for terminal-style output.
 *
 * Understands SGR: bold/dim/italic/underline/strikethrough, inverse, the
 * 16 base colours (fg and bg), 256-colour and truecolor. Every other escape
 * sequence is dropped, and carriage-return progress redraws collapse to the
 * last frame. Inverse is resolved here, so segments carry final fg/bg.
 *
 * Colours come back as either a theme name (the 8 base colours plus the
 * terminal's default "foreground"/"background", which inverse swaps) or a
 * `#rrggbb` literal (256/truecolor). Callers map names to theme tokens and
 * draw literals as inline styles — the one place a raw colour is legitimate,
 * because the program, not the theme, chose it. Bright (90–97 / 100–107)
 * variants fold onto the base names; the theme's tokens are already bright.
 */

export type NamedColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "foreground"
  | "background";

export type AnsiColor = NamedColor | `#${string}`;

export interface AnsiSegment {
  text: string;
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

const BASE: NamedColor[] = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

// CSI SGR (…m) is interpreted; every other escape is stripped first.
const SGR = /\x1b\[([0-9;:]*)m/g;
const OTHER_ESCAPES = /\x1b(?:\[[0-9;:?]*[A-Za-ln-z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

/** Strip every escape sequence — plain text for copy/measure. */
export function stripAnsi(text: string): string {
  return text.replace(SGR, "").replace(OTHER_ESCAPES, "");
}

const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
const rgb = (r: number, g: number, b: number): AnsiColor => `#${hex(r)}${hex(g)}${hex(b)}`;

/** xterm 256-colour index → colour (0–15 stay theme colours). */
function color256(n: number): AnsiColor | undefined {
  if (!(n >= 0 && n <= 255)) return undefined;
  if (n < 16) return BASE[n % 8];
  if (n < 232) {
    const i = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return rgb(level(Math.floor(i / 36)), level(Math.floor((i % 36) / 6)), level(i % 6));
  }
  const v = 8 + (n - 232) * 10;
  return rgb(v, v, v);
}

/** Relative luminance 0–1 of a `#rrggbb` literal (for readable text on it). */
export function luminance(color: string): number {
  const n = parseInt(color.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

interface Pen {
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

const fresh = (): Pen => ({ bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false });

function applySgr(pen: Pen, params: number[]): void {
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i];
    if (p === 0) Object.assign(pen, fresh(), { fg: undefined, bg: undefined });
    else if (p === 1) pen.bold = true;
    else if (p === 2) pen.dim = true;
    else if (p === 3) pen.italic = true;
    else if (p === 4) pen.underline = true;
    else if (p === 7) pen.inverse = true;
    else if (p === 9) pen.strike = true;
    else if (p === 22) pen.bold = pen.dim = false;
    else if (p === 23) pen.italic = false;
    else if (p === 24) pen.underline = false;
    else if (p === 27) pen.inverse = false;
    else if (p === 29) pen.strike = false;
    else if (p >= 30 && p <= 37) pen.fg = BASE[p - 30];
    else if (p === 39) pen.fg = undefined;
    else if (p >= 40 && p <= 47) pen.bg = BASE[p - 40];
    else if (p === 49) pen.bg = undefined;
    else if (p >= 90 && p <= 97) pen.fg = BASE[p - 90];
    else if (p >= 100 && p <= 107) pen.bg = BASE[p - 100];
    else if (p === 38 || p === 48) {
      let color: AnsiColor | undefined;
      if (params[i + 1] === 5) {
        color = color256(params[i + 2]);
        i += 2;
      } else if (params[i + 1] === 2) {
        color = rgb(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0);
        i += 4;
      }
      if (color) {
        if (p === 38) pen.fg = color;
        else pen.bg = color;
      }
    }
  }
}

function segmentFor(pen: Pen, text: string): AnsiSegment {
  let fg = pen.fg;
  let bg = pen.bg;
  if (pen.inverse) {
    const swappedFg: AnsiColor = bg ?? "background";
    const swappedBg: AnsiColor = fg ?? "foreground";
    fg = swappedFg;
    bg = swappedBg;
  }
  return {
    text,
    ...(fg && { fg }),
    ...(bg && { bg }),
    ...(pen.bold && { bold: true }),
    ...(pen.dim && { dim: true }),
    ...(pen.italic && { italic: true }),
    ...(pen.underline && { underline: true }),
    ...(pen.strike && { strike: true }),
  };
}

const paramsOf = (raw: string): number[] =>
  raw === "" ? [0] : raw.replace(/:/g, ";").split(";").map((n) => Number(n) || 0);

/** One array of segments per output line. */
export function parseAnsi(raw: string): AnsiSegment[][] {
  const text = raw.replace(OTHER_ESCAPES, "").replace(/\r\n/g, "\n");
  const pen = fresh();
  const lines: AnsiSegment[][] = [];

  for (const rawLine of text.split("\n")) {
    // A progress bar redraws with \r — only the last frame survives. The
    // pen still has to see every escape in the dropped frames.
    const cut = rawLine.lastIndexOf("\r");
    if (cut >= 0) {
      for (const m of rawLine.slice(0, cut).matchAll(SGR)) applySgr(pen, paramsOf(m[1]));
    }
    const line = cut >= 0 ? rawLine.slice(cut + 1) : rawLine;

    const segments: AnsiSegment[] = [];
    let last = 0;
    const push = (chunk: string) => {
      if (chunk) segments.push(segmentFor(pen, chunk));
    };
    for (const m of line.matchAll(SGR)) {
      push(line.slice(last, m.index));
      last = m.index + m[0].length;
      applySgr(pen, paramsOf(m[1]));
    }
    push(line.slice(last));
    lines.push(segments);
  }
  return lines;
}
