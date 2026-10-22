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

