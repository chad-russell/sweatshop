/**
 * Project CRUD steps (0033 B) and their approval previews. Split from the old single steps.ts - every function
 * keeps its "use step" directive; Node/sqlite imports stay lazy inside
 * each step body, and relative imports stay relative (the workflow
 * bundle has no "@/" alias).
 */

/** 0033 B: the create input shared by the preview and create steps. */
export interface CreateProjectToolInput {
  id: string;
  name: string;
  description?: string | null;
  repos?: { name: string; url: string }[];
  testCommand?: string | null;
  branchPrefix?: string | null;
  defaultRoute?: unknown;
}

/** 0033 B: list every project with its repos and work defaults. */
export async function listProjectsStep(): Promise<unknown> {
  "use step";
  const { listProjectsTool } = await import("../../../lib/agent/tools/projects");
  return listProjectsTool();
}

/** 0033 B: validate a create (the approval preview renders its summary). */
export async function createProjectPreviewStep(input: CreateProjectToolInput): Promise<unknown> {
  "use step";
  const { createProjectPreview } = await import("../../../lib/agent/tools/projects");
  return createProjectPreview(input);
}

/** 0033 B: create the approved project (repos atomically, then extras). */
export async function createProjectStep(input: {
  id: string;
  name: string;
  description?: string | null;
  repos?: { name: string; url: string }[];
  testCommand?: string | null;
  branchPrefix?: string | null;
  defaultRoute?: unknown;
}): Promise<unknown> {
  "use step";
  const [{ db }, { createProject, setProjectWorkSettings }, { setProjectModelSettings }] = await Promise.all([
    import("../../../db"),
    import("../../../db/projects"),
    import("../../../lib/providers/settings"),
  ]);
  const created = createProject(db(), input);
  if (!created.ok) return created;
  if (input.testCommand !== undefined || input.branchPrefix !== undefined) {
    setProjectWorkSettings(db(), created.project.id, {
      ...(input.testCommand !== undefined ? { testCommand: input.testCommand } : {}),
      ...(input.branchPrefix !== undefined ? { branchPrefix: input.branchPrefix } : {}),
    });
  }
  if (input.defaultRoute !== undefined) {
    setProjectModelSettings(db(), created.project.id, { defaultRoute: input.defaultRoute });
  }
  return created;
}

/** 0033 B: apply an edit batch (partial, with a refusal report). */
export async function editProjectStep(
  input: Parameters<(typeof import("../../../lib/agent/tools/projects"))["editProjectTool"]>[0],
): Promise<unknown> {
  "use step";
  const { editProjectTool } = await import("../../../lib/agent/tools/projects");
  return editProjectTool(input);
}

/** 0033 B: the delete cascade preview Chad approves. */
export async function deleteProjectPreviewStep(projectId: string): Promise<unknown> {
  "use step";
  const { deleteProjectPreview } = await import("../../../lib/agent/tools/projects");
  return deleteProjectPreview(projectId);
}

/** 0033 B: run the approved delete cascade. */
export async function deleteProjectStep(projectId: string): Promise<unknown> {
  "use step";
  const { deleteProjectFully } = await import("../../../lib/projects");
  return deleteProjectFully(projectId);
}
