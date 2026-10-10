import { db } from "@/db";
import {
  checkNewProject,
  getProject,
  listLiveProjectSandboxes,
  listProjectRepos,
  listProjectsWithRepos,
  removeProjectRepo,
  addProjectRepo,
  renameProject,
  setProjectImage,
  setProjectWorkSettings,
} from "@/db/projects";
import { setProjectModelSettings } from "@/lib/providers/settings";

/**
 * 0033 Phase B: the project tools' cores — the agent's half of the
 * "just chat to set it up" world. The store's existing write paths do
 * the work (the 0015 pattern: UI and tools share cores); this file
 * composes them with value-shaped, partial-with-report semantics.
 */

export type ToolResult<T> = ({ ok: true } & T) | { ok: false; code: string; message: string; issues?: string[] };

export async function listProjectsTool(): Promise<
  ToolResult<{ projects: { id: string; name: string; description: string | null; repos: { name: string; url: string }[]; testCommand: string | null; branchPrefix: string | null }[] }>
> {
  const out = listProjectsWithRepos(db()).map(({ id }) => {
    const project = getProject(db(), id)!;
    return {
      id,
      name: project.name,
      description: project.description ?? null,
      repos: listProjectRepos(db(), id).map((r) => ({ name: r.name, url: r.url })),
      testCommand: project.testCommand ?? null,
      branchPrefix: project.branchPrefix ?? null,
    };
  });
  return { ok: true, projects: out };
}

/** The approval preview for create_project: validates everything and
 * renders the one-line summary Chad approves. */
export function createProjectPreview(input: {
  id: string;
  name: string;
  description?: string | null;
  repos?: { name: string; url: string }[];
  testCommand?: string | null;
  branchPrefix?: string | null;
  defaultRoute?: unknown;
}): ToolResult<{ summary: string }> {
  const checked = checkNewProject(db(), input);
  if (!checked.ok) return checked;
  const extras = [
    ...(input.testCommand ? [`test command: \`${input.testCommand}\``] : []),
    ...(input.branchPrefix ? [`branch prefix: ${input.branchPrefix}/`] : []),
    ...(input.defaultRoute ? [`default route: ${JSON.stringify(input.defaultRoute)}`] : []),
  ];
  const repos = checked.repos.length > 0 ? ` with repo ${checked.repos.join(", ")}` : "";
  return {
    ok: true,
    summary: `Create project ${checked.id} ("${input.name.trim()}")${repos}${extras.length ? ` — ${extras.join("; ")}` : ""}?`,
  };
}

/** edit_project: apply each present field, report every refusal —
 * partial by design, so one bad field never blocks the rest. */
export function editProjectTool(input: {
  id: string;
  name?: string;
  testCommand?: string | null;
  branchPrefix?: string | null;
  imageRef?: string | null;
  defaultRoute?: unknown;
  allowedProviders?: unknown;
  allowedHarnesses?: unknown;
  reposToAdd?: { name: string; url: string }[];
  reposToRemove?: string[];
}): ToolResult<{ applied: string[]; issues: string[] }> {
  const applied: string[] = [];
  const issues: string[] = [];
  const note = (label: string, result: { ok: boolean; code?: string; message?: string; issues?: string[] }) => {
    if (result.ok) applied.push(label);
    else issues.push(`${label}: ${result.issues?.join("; ") ?? result.message ?? "failed"}`);
  };

  if (!getProject(db(), input.id)) return { ok: false, code: "not-found", message: `no project ${input.id}` };

  if (input.name !== undefined) note("name", renameProject(db(), input.id, input.name));
  if (input.testCommand !== undefined || input.branchPrefix !== undefined) {
    note(
      "work defaults",
      setProjectWorkSettings(db(), input.id, {
        ...(input.testCommand !== undefined ? { testCommand: input.testCommand } : {}),
        ...(input.branchPrefix !== undefined ? { branchPrefix: input.branchPrefix } : {}),
      }),
    );
  }
  if (input.imageRef !== undefined) note("image", setProjectImage(db(), input.id, input.imageRef));
  if (input.defaultRoute !== undefined || input.allowedProviders !== undefined || input.allowedHarnesses !== undefined) {
    note(
      "models",
      setProjectModelSettings(db(), input.id, {
        ...(input.defaultRoute !== undefined ? { defaultRoute: input.defaultRoute } : {}),
        ...(input.allowedProviders !== undefined ? { allowedProviders: input.allowedProviders } : {}),
        ...(input.allowedHarnesses !== undefined ? { allowedHarnesses: input.allowedHarnesses } : {}),
      }),
    );
  }
  for (const repo of input.reposToAdd ?? []) {
    note(`repo +${repo.name}`, addProjectRepo(db(), input.id, repo));
  }
  for (const name of input.reposToRemove ?? []) {
    const repo = listProjectRepos(db(), input.id).find((r) => r.name === name);
    if (!repo) {
      issues.push(`repo -${name}: no such repo in this project`);
      continue;
    }
    note(`repo -${name}`, removeProjectRepo(db(), input.id, repo.id));
  }

  if (applied.length === 0 && issues.length > 0) {
    return { ok: false, code: "invalid", message: "nothing applied", issues };
  }
  return { ok: true, applied, issues };
}

/** The approval preview for delete_project: the cascade, in numbers. */
export function deleteProjectPreview(projectId: string): ToolResult<{ summary: string }> {
  const project = getProject(db(), projectId);
  if (!project) return { ok: false, code: "not-found", message: `no project ${projectId}` };
  const sandboxes = listLiveProjectSandboxes(db(), projectId);
  const repos = listProjectRepos(db(), projectId);
  const parts = [
    `${repos.length} repo${repos.length === 1 ? "" : "s"}`,
    ...(sandboxes.length ? [`${sandboxes.length} sandbox${sandboxes.length === 1 ? "" : "es"} destroyed`] : []),
    "its conversations, previews, and folders deleted",
  ];
  return {
    ok: true,
    summary: `Delete project ${projectId} ("${project.name}") — ${parts.join(", ")}? Credentials are untouched; this cannot be undone.`,
  };
}
