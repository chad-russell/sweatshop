/**
 * Normalise a bash tool call into what the terminal card draws. Two
 * producers feed it: the chat's own `bash` tool (output is
 * `{exitCode, stdout, stderr}`) and the pi/claude harness (output is plain
 * text ending in `(exit N)`; input may be clipped mid-JSON).
 */

export interface BashView {
  command: string;
  /** The caller's one-line "what this is for" (the chat shell tools'
   *  optional `description`); absent for harness calls and older rows. */
  description: string | undefined;
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  /** An output (or error) has been seen — distinguishes "no output" from "not yet". */
  hasOutput: boolean;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Pull `command` out of an input that may have been clipped mid-JSON. */
function commandOf(input: unknown): string {
  const obj = asObject(input);
  if (typeof obj?.command === "string") return obj.command;
  if (typeof input === "string") {
    const m = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(input);
    if (m) {
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
      }
    }
    return input;
  }
  return "";
}

/** The optional `description` — same clipped-JSON tolerance as the command. */
export function descriptionOf(input: unknown): string | undefined {
  const obj = asObject(input);
  let raw: string | undefined;
  if (obj) raw = typeof obj.description === "string" ? obj.description : undefined;
  else if (typeof input === "string") {
    const m = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
    if (m) {
      try {
        raw = JSON.parse(`"${m[1]}"`) as string;
      } catch {
        raw = m[1];
      }
    }
  }
  const text = raw?.replace(/\s+/g, " ").trim();
  return text ? text : undefined;
}

const EXIT_SUFFIX = /\n*\(exit (-?\d+)\)\s*$/;

export function parseBash(input: unknown, output: unknown, errorText?: string): BashView {
  const command = commandOf(input);
  const description = descriptionOf(input);
  const obj = asObject(output);
  if (obj && ("stdout" in obj || "stderr" in obj || "exitCode" in obj)) {
    return {
      command,
      description,
      stdout: typeof obj.stdout === "string" ? obj.stdout : "",
      stderr: typeof obj.stderr === "string" ? obj.stderr : "",
      exitCode: typeof obj.exitCode === "number" ? obj.exitCode : undefined,
      hasOutput: true,
    };
  }
  if (typeof output === "string") {
    const m = EXIT_SUFFIX.exec(output);
    return {
      command,
      description,
      stdout: m ? output.slice(0, m.index) : output,
      stderr: "",
      exitCode: m ? Number(m[1]) : undefined,
      hasOutput: true,
    };
  }
  if (errorText) return { command, description, stdout: "", stderr: errorText, exitCode: undefined, hasOutput: true };
  return { command, description, stdout: "", stderr: "", exitCode: undefined, hasOutput: false };
}

/**
 * A leading `cd <dir> &&` (or `;`) is navigation, not the command: the card
 * shows the directory as a dim prompt prefix and leads with what actually ran.
 * Only a single plain-word directory qualifies — anything with expansions,
 * quoting tricks or a `cd` that is not first is left untouched.
 */
export function splitCd(command: string): { cwd?: string; rest: string } {
  const m = /^\s*cd\s+(?:"([^"$`\\]+)"|'([^']+)'|([\w@%+=:,./~-]+))\s*(?:&&|;)\s*([\s\S]+)$/.exec(command);
  if (!m) return { rest: command };
  const rest = m[4]!.trimStart();
  return rest ? { cwd: m[1] ?? m[2] ?? m[3], rest } : { rest: command };
}
