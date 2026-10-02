/**
 * Normalise a bash tool call into what the terminal card draws. Two
 * producers feed it: the chat's own `bash` tool (output is
 * `{exitCode, stdout, stderr}`) and the pi/claude harness (output is plain
 * text ending in `(exit N)`; input may be clipped mid-JSON).
 */

export interface BashView {
  command: string;
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

const EXIT_SUFFIX = /\n*\(exit (-?\d+)\)\s*$/;

export function parseBash(input: unknown, output: unknown, errorText?: string): BashView {
  const command = commandOf(input);
  const obj = asObject(output);
  if (obj && ("stdout" in obj || "stderr" in obj || "exitCode" in obj)) {
    return {
      command,
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
      stdout: m ? output.slice(0, m.index) : output,
      stderr: "",
      exitCode: m ? Number(m[1]) : undefined,
      hasOutput: true,
    };
  }
  if (errorText) return { command, stdout: "", stderr: errorText, exitCode: undefined, hasOutput: true };
  return { command, stdout: "", stderr: "", exitCode: undefined, hasOutput: false };
}
