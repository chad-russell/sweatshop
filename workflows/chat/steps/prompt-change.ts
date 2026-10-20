import { diffLines, type DiffLine } from "../../../lib/plan";

export type PromptChangeTarget =
  | { kind: "section"; key: "base" | "harness_steering" | "host_routing" }
  | { kind: "skill"; id: string };

export interface PromptChangePatch {
  body?: string;
  description?: string;
  thread?: boolean;
  status?: "active" | "disabled" | "deleted";
}

export interface PromptChangeCard {
  kind: "prompt_change";
  target: PromptChangeTarget;
  title: string;
  currentVersion: number;
  patch: PromptChangePatch;
  before: PromptChangePatch | null;
  affectedThreads?: { id: string; title: string | null }[];
  diff?: DiffLine[];
}

export type PromptChangeInput = {
  kind: "section" | "skill";
  key: string;
  body?: string;
  description?: string;
  thread?: boolean;
  status?: "active" | "disabled" | "deleted";
  note: string;
};

const SECTION_KEYS = ["base", "harness_steering", "host_routing"] as const;
const SKILL_ID = /^[a-z][a-z0-9-]{0,40}$/;
const SECTION_MAX_BYTES = 32 * 1024;
const SKILL_MAX_BYTES = 64 * 1024;

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalid(...issues: string[]) {
  return { ok: false as const, code: "invalid" as const, issues, message: issues.join("; ") };
}

/** Validate and snapshot a proposal before an approval row is opened. */
export async function promptChangePreviewStep(input: PromptChangeInput) {
  "use step";
  const [{ db }, store] = await Promise.all([
    import("../../../db"),
    import("../../../db/prompt-settings"),
  ]);

  const fields = [input.body, input.description, input.thread, input.status];
  if (fields.every((value) => value === undefined)) return invalid("at least one change is required");

  let target: PromptChangeTarget;
  if (input.kind === "section") {
    if (!(SECTION_KEYS as readonly string[]).includes(input.key)) {
      return { ok: false as const, code: "not-found" as const, message: `unknown prompt section: ${input.key}` };
    }
    if (input.description !== undefined || input.thread !== undefined || input.status !== undefined) {
      return invalid("prompt sections accept only body changes");
    }
    if (input.body === undefined) return invalid("a section change requires body");
    if (bytes(input.body) > SECTION_MAX_BYTES) return invalid("prompt section body exceeds 32 KiB");
    target = { kind: "section", key: input.key as (typeof SECTION_KEYS)[number] };
  } else {
    if (!SKILL_ID.test(input.key)) return invalid("skill id must match ^[a-z][a-z0-9-]{0,40}$");
    if (input.body !== undefined && bytes(input.body) > SKILL_MAX_BYTES) return invalid("skill body exceeds 64 KiB");
    if (input.description !== undefined && input.description.length > 500) return invalid("skill description exceeds 500 characters");
    target = { kind: "skill", id: input.key };
  }

  const current = store.getTarget(db(), target);
  if (target.kind === "skill" && !current && input.body === undefined) {
    return invalid("creating a skill requires body");
  }
  const patch: PromptChangePatch = {
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.thread !== undefined ? { thread: input.thread } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  };
  // Only snapshot old metadata that is actually being proposed. A body
  // proposal's old text is already present in its diff; metadata-only
  // proposals must not copy unrelated prompt text into pending_inputs.
  const before: PromptChangePatch | null = current && target.kind === "skill"
    ? {
        ...(input.description !== undefined ? { description: current.description } : {}),
        ...(input.thread !== undefined ? { thread: current.thread } : {}),
        ...(input.status !== undefined ? { status: current.status } : {}),
      }
    : null;
  const title = target.kind === "section"
    ? `Change prompt section ${target.key}`
    : `${current ? "Change" : "Create"} skill ${target.id}`;
  let affectedThreads: { id: string; title: string | null }[] = [];
  if (target.kind === "skill" && input.status !== undefined && current) {
    const [{ and, eq, isNotNull, isNull }, { conversations }] = await Promise.all([
      import("drizzle-orm"),
      import("../../../db/schema"),
    ]);
    affectedThreads = db().select({ id: conversations.id, title: conversations.title })
      .from(conversations)
      .where(and(
        eq(conversations.skill, target.id),
        isNotNull(conversations.activeRunId),
        isNull(conversations.trashedAt),
      ))
      .all();
  }
  const card: PromptChangeCard = {
    kind: "prompt_change",
    target,
    title,
    currentVersion: current?.version ?? 0,
    patch,
    before,
    ...(affectedThreads.length > 0 ? { affectedThreads } : {}),
    ...(input.body !== undefined ? { diff: diffLines(current?.body ?? "", input.body) } : {}),
  };
  return {
    ok: true as const,
    target,
    patch,
    expectedVersion: current?.version ?? 0,
    summary: `${title}. Review the complete proposed change below.`,
    card,
  };
}

/** Apply the exact snapshotted patch after approval, preserving its base version. */
export async function applyApprovedPromptChangeStep(
  target: PromptChangeTarget,
  patch: PromptChangePatch,
  expectedVersion: number,
  note: string,
) {
  "use step";
  const [{ db }, { applyApprovedChange }] = await Promise.all([
    import("../../../db"),
    import("../../../db/prompt-settings"),
  ]);
  return applyApprovedChange(db(), target, { patch, expectedVersion, note });
}
