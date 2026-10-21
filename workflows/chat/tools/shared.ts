/**
 * Shared tool-set pieces: the commandDescription zod schema used by
 * every shell tool (bash, sandbox_exec, exec).
 */
import { z } from "zod";

import { ownerName } from "../../../lib/agent/owner";

export const commandDescription = z
  .string()
  .min(1)
  .max(120)
  .describe(
    "What this command is for, in 5-10 words of active voice — e.g. \"Run the store tests\", " +
      `"Find callers of resolveRoute". Shown to ${ownerName()} as the call's title.`,
  );

/** 0055 v7 part B: the optional phase override every harness tool and
 *  start_thread share — see docs/0055's "Phase handoff". */
export const phaseArg = z
  .string()
  .optional()
  .describe(
    "Work this as a specific phase of the current mode (id or name) — overrides this chat's current " +
      "phase for this call only. Only valid in a moded chat; an unknown phase lists the declared ones.",
  );

