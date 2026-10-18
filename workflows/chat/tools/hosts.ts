/**
 * The 0043 host channel: exec (approval-gated, hosts enumerated in the description).
 */

import { tool } from "ai";
import { z } from "zod";
import { chatApprovalHook } from "../hooks";
import { isLockoutSensitiveCommand } from "../../../lib/hosts/lockout";
import { commandDescription } from "./shared";
import { getHostAutoApproveStep, hostExecPreviewStep, hostExecStep, pendingStep } from "../steps";

export function hostTools(
  conversationId: string,
  hosts: { name: string; address: string; user: string; apiBase: string | null }[],
  hasProject: boolean,
) {
  return {
    // 0043: the host channel — a project with hosts on its allow-list
    // gets exec; every call is approval-gated (the create_pr mechanism,
    // 0034 A: validate without connecting, then Chad decides, then run).
    ...(hasProject && hosts.length > 0 && {
      exec: tool({
        description:
          "Repo work happens in your sandbox, never here — exec is only for live state on a real host " +
          "(check, restart, roll back, read logs); never edit a repo checkout on a host, and never open a PR " +
          "from one. Run a command on a real host over SSH, as the host's user, via bash -lc — calls wait for " +
          "Chad's approval with the exact command on his card, unless he has turned on auto-approve for this " +
          "chat (lockout-sensitive commands always ask). This project's hosts: " +
          hosts
            .map((h) => `${h.name} (${h.user}@${h.address}${h.apiBase ? `, API ${h.apiBase}` : ""})`)
            .join("; ") +
          ". Before acting on a host, read its docs in the project's repos (AGENTS.md / hosts READMEs — they carry " +
          "the SSH notes and lockout rules) and treat lockout-sensitive services (sshd, networking, nebula, gateway " +
          "caddy) per those rules. Secrets: reference PATHS, never contents — e.g. " +
          'curl -H "Authorization: Bearer $(cat /path/to/token)"; API calls run as curl on a host that holds the ' +
          "credential. Verify what you changed afterward (systemctl is-active, journalctl tails, curl the service).",
        inputSchema: z.object({
          host: z.string().min(1).describe("Host name from this project's list"),
          command: z.string().min(1).max(20_000).describe("The bash command to run on the host"),
          description: commandDescription,
          timeout: z
            .number()
            .int()
            .positive()
            .max(900)
            .optional()
            .describe("Wall-clock seconds before the channel is cut (default 120, max 900)"),
        }),
        execute: async (input, { toolCallId }) => {
          const preview = (await hostExecPreviewStep(conversationId, input)) as
            | { ok: true; summary: string; host: { name: string; address: string; user: string }; command: string; timeoutSec: number }
            | { ok: false; code: string; message: string };
          if (!preview.ok) return preview;
          // 0043 amendment: read fresh on every call (not cached per turn)
          // so flipping the chat's toggle takes effect on the very next
          // command; a lockout-sensitive command always asks regardless
          // (a guard rail, not a security boundary).
          const autoApprove = await getHostAutoApproveStep(conversationId);
          if (autoApprove && !isLockoutSensitiveCommand(preview.command)) {
            return hostExecStep(conversationId, input, true);
          }
          // 0043 UX: a structured card so the inbox renders a terminal
          // block (host + command), not the generic JSON dump.
          await pendingStep(conversationId, toolCallId, preview.summary, "approval", {
            type: "exec",
            host: preview.host.name,
            user: preview.host.user,
            address: preview.host.address,
            command: preview.command,
            timeoutSec: preview.timeoutSec,
            ...(input.description ? { description: input.description } : {}),
          });
          const answer = await chatApprovalHook.create({ token: toolCallId });
          if (!(answer.kind === "approval" && answer.approved)) {
            const comment = answer.kind === "approval" ? answer.comment?.trim() : undefined;
            return {
              ok: false as const,
              code: comment ? ("changes-requested" as const) : ("denied" as const),
              message: comment
                ? `Chad rejected the command with a comment — nothing ran. Address it, then call exec again: ${comment}`
                : "Chad declined — nothing ran on the host",
            };
          }
          return hostExecStep(conversationId, input, false);
        },
      }),
    }),
  };
}
