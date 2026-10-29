import { diffLines, type DiffLine } from "../../../lib/text-diff";

export type PromptChangeTarget = { kind: "section"; key: "base" | "harness_steering" | "host_routing" };

export interface PromptChangePatch {
  body?: string;
}

export interface PromptChangeCard {
  kind: "prompt_change";
  /** A section edit, or (0088) a `save_skill` proposal reusing this card. */
  target: PromptChangeTarget | { kind: "skill"; id: string };
  title: string;
  currentVersion: number;
  patch: PromptChangePatch;
  before: PromptChangePatch | null;
  diff?: DiffLine[];
}

export type PromptChangeInput = {
  key: string;
  body: string;
  note: string;
};

const SECTION_KEYS = ["base", "harness_steering", "host_routing"] as const;
const SECTION_MAX_BYTES = 32 * 1024;

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

  if (!(SECTION_KEYS as readonly string[]).includes(input.key)) {
    return { ok: false as const, code: "not-found" as const, message: `unknown prompt section: ${input.key}` };
  }
  if (bytes(input.body) > SECTION_MAX_BYTES) return invalid("prompt section body exceeds 32 KiB");
  const target: PromptChangeTarget = { kind: "section", key: input.key as (typeof SECTION_KEYS)[number] };

  const current = store.getTarget(db(), target);
  const patch: PromptChangePatch = { body: input.body };
  const title = `Change prompt section ${target.key}`;
  const card: PromptChangeCard = {
    kind: "prompt_change",
    target,
    title,
    currentVersion: current?.version ?? 0,
    patch,
    before: null,
    diff: diffLines(current?.body ?? "", input.body),
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
