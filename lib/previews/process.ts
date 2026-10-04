import type { SandboxHandle } from "@/lib/sandboxes/provider";

/**
 * 0016: the preview process, inside the sandbox. A preview runs
 * DETACHED (its own session via setsid, stdio to a log file, pid in a
 * pid file) so it is never a child of the Next process — a Next restart,
 * dev reload, or `./dev` restart leaves it running. Everything here is a
 * shell snippet run through the provider seam's `SandboxHandle.run`; the
 * sandbox is the source of truth for whether the process is up.
 */

export const PREVIEW_STATE_DIR = "/work/.previews";

export function previewLogPath(id: string): string {
  return `${PREVIEW_STATE_DIR}/${id}.log`;
}

/** 0017: the resolved env a preview booted with (debug copy, 0600). */
export function previewEnvPath(id: string): string {
  return `${PREVIEW_STATE_DIR}/${id}.env`;
}

export function previewPidPath(id: string): string {
  return `${PREVIEW_STATE_DIR}/${id}.pid`;
}

/** POSIX single-quote a value for a bash command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Kill the preview's whole process group (setsid made pid = pgid). */
function killSnippet(id: string): string {
  const pidFile = shellQuote(previewPidPath(id));
  return [
    `if [ -f ${pidFile} ]; then`,
    `  pid=$(cat ${pidFile})`,
    `  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then`,
    `    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null`,
    `    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done`,
    `    kill -KILL -- "-$pid" 2>/dev/null || true`,
    `  fi`,
    `  rm -f ${pidFile}`,
    `fi`,
  ].join("\n");
}

export interface StartProcessInput {
  id: string;
  workDir: string;
  command: string;
  env: Record<string, string>;
  /** 0017: when set, also written to /work/.previews/<id>.env (0600)
   *  for debugging inside the sandbox — the process env stays the
   *  source of truth. */
  envFileContent?: string;
}

/**
 * (Re)start the preview process: stop any previous one, truncate the
 * log, launch detached. Resolves once launched — not once healthy (the
 * caller probes). Throws with the shell's stderr if it could not launch.
 */
export async function startProcess(handle: SandboxHandle, input: StartProcessInput): Promise<void> {
  const dir = shellQuote(PREVIEW_STATE_DIR);
  const log = shellQuote(previewLogPath(input.id));
  const pidFile = shellQuote(previewPidPath(input.id));
  const script = [
    `mkdir -p ${dir}`,
    killSnippet(input.id),
    ...(input.envFileContent !== undefined
      ? [
          `umask 077 && printf %s ${shellQuote(input.envFileContent)} > ${shellQuote(previewEnvPath(input.id))} && chmod 600 ${shellQuote(previewEnvPath(input.id))}`,
        ]
      : []),
    `cd ${shellQuote(input.workDir)} || { echo "no such directory: ${input.workDir.replace(/"/g, "")}" >&2; exit 3; }`,
    `setsid nohup bash -lc ${shellQuote(input.command)} > ${log} 2>&1 < /dev/null &`,
    `echo $! > ${pidFile}`,
  ].join("\n");
  const result = await handle.run(script, input.env, "/");
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `could not launch (exit ${result.exitCode})`);
  }
}

/** Stop the preview process (no-op if it is not running). */
export async function stopProcess(handle: SandboxHandle, id: string): Promise<void> {
  await handle.run(killSnippet(id), undefined, "/");
}

/** Is the preview's process alive? */
export async function processAlive(handle: SandboxHandle, id: string): Promise<boolean> {
  const pidFile = shellQuote(previewPidPath(id));
  const result = await handle.run(
    `pid=$(cat ${pidFile} 2>/dev/null) && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo alive`,
    undefined,
    "/",
  );
  return result.stdout.trim() === "alive";
}

/** The last `lines` lines of the preview's log ("" when there is none). */
export async function logTail(handle: SandboxHandle, id: string, lines = 80): Promise<string> {
  const result = await handle.run(
    `tail -n ${Math.max(1, Math.min(2_000, Math.floor(lines)))} ${shellQuote(previewLogPath(id))} 2>/dev/null || true`,
    undefined,
    "/",
  );
  return result.stdout;
}
