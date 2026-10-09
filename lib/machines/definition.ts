import { z } from "zod";
import { chatRouteSchema, harnessRouteSchema } from "../providers/route";

/**
 * 0009 machine definitions: the JSON a machine row stores and every run
 * freezes a snapshot of. Pure — imported by the workflow body, the store,
 * the routes, and the UI, so no Node imports here.
 *
 * Validation enforces the doc's structural rules beyond the zod shape:
 * `start` and every `next.to` name a real stage (or the reserved
 * terminal `end`); `harness` and `publish` stages require
 * `workspace: "project"`. A stage with no `next` ends the run after
 * it; `{ to: "end" }` lets a branching stage (e.g. a human gate's
 * "accept") end it explicitly.
 */

/** Reserved transition target that completes the run. */
export const END = "end";

export const HARNESSES = ["pi", "claude"] as const;
export type StageHarness = (typeof HARNESSES)[number];

const stageId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/, "stage ids are lowercase kebab-case, ≤40 chars");

const transition = z.object({
  to: stageId,
  /** Shown to the agent (and on the human gate button) to pick a branch. */
  when: z.string().max(400).optional(),
});

const common = {
  title: z.string().min(1).max(80),
  instructions: z.string().max(20_000),
  next: z.array(transition).max(8),
  /** Visits before the run parks as needs-attention (loop bound). */
  maxVisits: z.number().int().min(1).max(20).optional(),
};

const harnessStage = z.object({
  kind: z.literal("harness"),
  harness: z.enum(HARNESSES),
  /** 0021: pin this stage's route (its `harness` must match the stage's).
   *  Absent = run override → project default → global default. */
  route: harnessRouteSchema.optional(),
  ...common,
});

const agentStage = z.object({
  /** 0010 Phase 5: an in-process WorkflowAgent turn (was "eve", 0009). */
  kind: z.literal("agent"),
  /** 0021: pin this stage's route (provider + model). Absent = run
   *  override → project default → global agent default. */
  route: chatRouteSchema.optional(),
  ...common,
});

const humanStage = z.object({
  kind: z.literal("human"),
  ...common,
});

/** 0034 A: deterministic — pushes the run's approved PR proposal and
 *  opens it. No model runs here; the human gate upstream was the
 *  approval. Instructions optional (nothing executes them — a note for
 *  the graph reader). */
const publishStage = z.object({
  kind: z.literal("publish"),
  title: z.string().min(1).max(80),
  instructions: z.string().max(20_000).optional(),
  next: z.array(transition).max(8),
  maxVisits: z.number().int().min(1).max(20).optional(),
});

export const stageSchema = z.discriminatedUnion("kind", [
  harnessStage,
  agentStage,
  humanStage,
  publishStage,
]);

export const machineDefinitionSchema = z
  .object({
    /** project: one run-owned container shared by every harness stage;
     *  none: no sandbox (harness stages not allowed). */
    workspace: z.enum(["project", "none"]),
    start: stageId,
    stages: z.record(stageId, stageSchema),
  })
  .superRefine((def, ctx) => {
    const ids = Object.keys(def.stages);
    if (ids.length === 0) {
      ctx.addIssue({ code: "custom", path: ["stages"], message: "at least one stage is required" });
      return;
    }
    if (ids.length > 30) {
      ctx.addIssue({ code: "custom", path: ["stages"], message: "at most 30 stages" });
    }
    if (def.stages[END]) {
      ctx.addIssue({ code: "custom", path: ["stages", END], message: `"${END}" is reserved (the run's terminal)` });
    }
    if (!def.stages[def.start]) {
      ctx.addIssue({ code: "custom", path: ["start"], message: `start stage "${def.start}" does not exist` });
    }
    for (const [id, stage] of Object.entries(def.stages)) {
      const seen = new Set<string>();
      stage.next.forEach((t, i) => {
        if (t.to !== END && !def.stages[t.to]) {
          ctx.addIssue({
            code: "custom",
            path: ["stages", id, "next", i, "to"],
            message: `stage "${t.to}" does not exist`,
          });
        }
        if (seen.has(t.to)) {
          ctx.addIssue({
            code: "custom",
            path: ["stages", id, "next", i, "to"],
            message: `duplicate transition to "${t.to}"`,
          });
        }
        seen.add(t.to);
      });
      if (stage.kind === "harness" && stage.route && stage.route.harness !== stage.harness) {
        ctx.addIssue({
          code: "custom",
          path: ["stages", id, "route", "harness"],
          message: `route harness "${stage.route.harness}" does not match the stage's harness "${stage.harness}"`,
        });
      }
      if ((stage.kind === "harness" || stage.kind === "publish") && def.workspace !== "project") {
        ctx.addIssue({
          code: "custom",
          path: ["stages", id, "kind"],
          message: `${stage.kind} stages need workspace: project`,
        });
      }
    }
  });

export type MachineDefinition = z.infer<typeof machineDefinitionSchema>;
export type Stage = z.infer<typeof stageSchema>;

export type DefinitionResult =
  | { ok: true; definition: MachineDefinition }
  | { ok: false; errors: string[] };

/** Validate an unknown value as a machine definition. */
export function parseDefinition(value: unknown): DefinitionResult {
  const result = machineDefinitionSchema.safeParse(value);
  if (result.success) return { ok: true, definition: result.data };
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`,
    ),
  };
}

/** Default per-stage visit bound. */
export const DEFAULT_MAX_VISITS = 3;
/** Agent steps per harness stage visit before the run parks. */
export const MAX_HARNESS_STEPS = 400;

/** Transition targets a stage may move to ([] = terminal). */
export function allowedTargets(stage: Stage): string[] {
  return stage.next.map((t) => t.to);
}
