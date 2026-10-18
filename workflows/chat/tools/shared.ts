import { z } from "zod";

/**
 * The per-conversation tool context: the closures' shared inputs. Groups
 * receive the same facts the single factory closed over (conversationId
 * plus the sandbox/project/host gates).
 */
export interface ToolContext {
  conversationId: string;
  hasSandbox: boolean;
  hasProject: boolean;
  hosts: { name: string; address: string; user: string; apiBase: string | null }[];
}

/** The shell tools' (bash, sandbox_exec, exec) "what this is for" line —
 *  the card's title, so Chad reads intent before the command. */
export const commandDescription = z
  .string()
  .min(1)
  .max(120)
  .describe(
    "What this command is for, in 5-10 words of active voice — e.g. \"Run the store tests\", " +
      "\"Find callers of resolveRoute\". Shown to Chad as the call's title.",
  );

