import { db } from "@/db";
import { getConversation } from "@/db/chat";
import { getPreview, listPreviewsForSandboxes } from "@/db/previews";
import { getConversationBinding } from "@/db/sandboxes";
import {
  openConversationSandbox,
  openInheritedSandbox,
  type BoundSandbox,
  type OpenedSandbox,
} from "@/lib/sandboxes/binding";
import type { SandboxProvider } from "@/lib/sandboxes/provider";
import {
  inferPreviewCommand,
  previewLogs,
  PreviewError,
  projectPreviewDefaults,
  startPreview,
  stopPreview,
  viewPreview,
  type PreviewDeps,
  type PreviewView,
} from "@/lib/previews/service";

/**
 * 0016: the preview tools' cores — start_preview / preview_status /
 * stop_preview. They run in the caller's 0013 binding (a chat's own or
 * attached sandbox, or an agent stage's inherited run sandbox), and the
 * preview belongs to that SANDBOX, so it outlives this turn and shows
 * on every chat or run bound there. Errors are values (0015 style) so
 * the model reads them and repairs its call.
 */

export type ToolResult<T> = ({ ok: true } & T) | { ok: false; code: string; message: string };

/** Where the tool runs: a chat (binds on first use) or an inherited binding. */
export type PreviewCaller =
  | { kind: "conversation"; conversationId: string }
  | { kind: "inherited"; sessionId: string; binding: BoundSandbox; projectId: string | null };

export interface StartPreviewInput {
  /** Directory, absolute or relative to the binding's work root. */
  dir?: string;
  command?: string;
  port?: number;
  label?: string;
}

function fail(err: unknown): { ok: false; code: string; message: string } {
  if (err instanceof PreviewError) return { ok: false, code: err.code, message: err.message };
  return { ok: false, code: "error", message: err instanceof Error ? err.message : String(err) };
}

async function open(caller: PreviewCaller, provider?: SandboxProvider): Promise<OpenedSandbox & { projectId: string | null; startedBy: string }> {
  if (caller.kind === "conversation") {
    const opened = await openConversationSandbox(caller.conversationId, provider);
    return {
      ...opened,
      projectId: getConversation(db(), caller.conversationId)?.projectId ?? null,
      startedBy: caller.conversationId,
    };
  }
  const opened = await openInheritedSandbox(caller.sessionId, caller.binding, provider);
  return { ...opened, projectId: caller.projectId, startedBy: caller.sessionId };
}

/** Resolve `dir` against the work root; default = the root's only repo, else the root. */
async function resolveDir(opened: OpenedSandbox, dir?: string): Promise<string> {
  const root = opened.workDir.replace(/\/+$/, "");
  if (dir) return dir.startsWith("/") ? dir : `${root}/${dir.replace(/^\.\/?/, "")}`;
  const listing = await opened.handle.run(
    `for d in */; do [ -d "$d/.git" ] && echo "\${d%/}"; done 2>/dev/null || true`,
    undefined,
    root,
  );
  const repos = listing.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return repos.length === 1 ? `${root}/${repos[0]}` : root;
}

export async function startPreviewTool(
  caller: PreviewCaller,
  input: StartPreviewInput,
  deps: PreviewDeps = {},
): Promise<ToolResult<{ preview: PreviewView; log?: string; note: string }>> {
  try {
    const opened = await open(caller, deps.provider);
    const workDir = await resolveDir(opened, input.dir);
    const defaults = projectPreviewDefaults(opened.projectId);
    let command = input.command ?? defaults.command ?? undefined;
    let port = input.port ?? defaults.port ?? undefined;
    if (!command) {
      const inferred = await inferPreviewCommand(opened.handle, workDir);
      if ("error" in inferred) return { ok: false, code: "no-command", message: inferred.error };
      command = inferred.command;
      port ??= inferred.port;
    }
    port ??= 3000;
    const { preview, log } = await startPreview(
      {
        sandboxId: opened.sandboxId,
        workDir,
        command,
        port,
        label: input.label ?? null,
        source: "worktree",
        startedBy: opened.startedBy,
      },
      deps,
    );
    const note =
      preview.status === "healthy"
        ? `serving at ${preview.url} — Chad can open it from the chat header`
        : preview.status === "starting"
          ? `launched but not answering on port ${port} yet — check preview_status, or the log below`
          : `the server exited — read the log, fix the cause, and call start_preview again (it restarts the same preview)`;
    return { ok: true, preview, ...(log ? { log: clip(log) } : {}), note };
  } catch (err) {
    return fail(err);
  }
}

function clip(text: string, limit = 6_000): string {
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

/** The caller's sandbox id without creating one (status/stop never bind). */
function callerSandboxId(caller: PreviewCaller): string | null {
  if (caller.kind === "inherited") return caller.binding.sandboxId;
  const binding = getConversationBinding(db(), caller.conversationId);
  return binding?.kind === "bound" ? binding.sandboxId : null;
}

export async function previewStatusTool(
  caller: PreviewCaller,
  input: { id?: string; lines?: number },
  deps: PreviewDeps = {},
): Promise<ToolResult<{ previews: (PreviewView & { log?: string })[] }>> {
  try {
    const sandboxId = callerSandboxId(caller);
    if (input.id) {
      const p = getPreview(db(), input.id);
      if (!p || p.deletedAt) return { ok: false, code: "not-found", message: `no preview ${input.id}` };
      const log = await previewLogs(p.id, input.lines ?? 60, deps);
      return { ok: true, previews: [{ ...viewPreview(p), log: clip(log) }] };
    }
    if (!sandboxId) return { ok: true, previews: [] };
    return { ok: true, previews: listPreviewsForSandboxes(db(), [sandboxId]).map(viewPreview) };
  } catch (err) {
    return fail(err);
  }
}

export async function stopPreviewTool(
  caller: PreviewCaller,
  input: { id: string },
  deps: PreviewDeps = {},
): Promise<ToolResult<{ preview: PreviewView }>> {
  try {
    const p = getPreview(db(), input.id);
    if (!p || p.deletedAt) return { ok: false, code: "not-found", message: `no preview ${input.id}` };
    if (p.sandboxId !== callerSandboxId(caller)) {
      return { ok: false, code: "not-yours", message: `preview ${input.id} runs in another sandbox — stop it from its page` };
    }
    return { ok: true, preview: await stopPreview(p.id, deps) };
  } catch (err) {
    return fail(err);
  }
}
