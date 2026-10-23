/**
 * 0082: the repetition guard. RCA: a start_thread child ran `npm run …`
 * (no package.json in its sandbox cwd) ~200 times, getting the same
 * ENOENT result every time, and burned its whole step budget never
 * noticing. A tool-call SIGNATURE is (toolName, input, result) — once
 * the same one lands 3 times in a turn, the turn injects a runtime note
 * telling the model to change approach or stop (lib/chat/budget.ts's
 * CONTINUE_TEXT is the model for the pattern: a runEvent-tagged user
 * row, drained into the next slice exactly like a steer message).
 */

export const LOOP_GUARD_THRESHOLD = 3;

/** FNV-1a 32-bit over the call's identity — cheap and stable across a
 *  replay (same toolName/input/output serialize the same way every
 *  time), not cryptographic: collisions just mean two different calls
 *  get counted as one, which only makes the guard fire a little early. */
export function toolCallSignature(toolName: string, input: unknown, output: unknown): string {
  const raw = `${toolName}\u0000${stable(input)}\u0000${stable(output)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function stable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function loopGuardText(toolName: string): string {
  return (
    `[loop guard] You have run ${toolName} with the same input ${LOOP_GUARD_THRESHOLD} times and got ` +
    "the same result each time. Do not repeat it — change approach (check cwd, paths, the error), or " +
    "stop and report what's blocking you."
  );
}
