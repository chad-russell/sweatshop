/**
 * 0010 tool set for the new chat runtime, assembled from the domain
 * groups (core, children, web, hosts, projects, sandbox). The factory
 * signature and gating rules are unchanged.
 */
import { coreTools } from "./core";
import { childTools } from "./children";
import { queryTools } from "./web";
import { hostTools } from "./hosts";
import { projectTools } from "./projects";
import { sandboxTools } from "./sandbox";

/**
 * 0010 tool set for the new chat runtime (0037 phase 5: the machine
 * tools are gone — machines were deleted). Built per conversation by
 * buildChatTools (a module-scope factory the workflow body calls —
 * tool executes close over the conversationId, and the whole agent is
 * rebuilt on every body replay so the closures are always fresh).
 *
 * The ask_chad execute deliberately has NO "use step": hook creation
 * needs workflow context (vendored HumanInTheLoop.md — "hooks are
 * workflow-level primitives"), and the enclosing agent step's arguments
 * are serializable (the model rides in SerializableChatModel), so the
 * turn can suspend on the hook mid-loop and resume. The sandbox- and
 * db-touching tools ARE steps — only step bodies may use Node APIs, and
 * their results (clipped/POJO) serialize into the run log.
 *
 * 0013: the conversation's sandbox binding decides the sandboxed tools —
 * "none" (no project, or "no sandbox" chosen) omits bash/pi/claude;
 * pending or bound keeps bash, and pi/claude also need a project (their
 * create_pr host tool is project-scoped). The tool cores open the
 * binding themselves; nothing here picks a sandbox.
 */

export function buildChatTools(
  conversationId: string,
  sandbox: {
    hasSandbox: boolean;
    hasProject: boolean;
    /** 0043: the project's host allow-list — empty (or absent) omits exec. */
    hosts?: { name: string; address: string; user: string; apiBase: string | null }[];
  } = { hasSandbox: true, hasProject: true },
) {
  const { hasSandbox, hasProject } = sandbox;
  const hosts = sandbox.hosts ?? [];
  return {
    ...coreTools(conversationId),
    ...childTools(conversationId),
    ...queryTools(),
    ...hostTools(conversationId, hosts, hasProject),
    ...projectTools(conversationId),
    ...sandboxTools(conversationId, hasSandbox, hasProject),
  };
}
