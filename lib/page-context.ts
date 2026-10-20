import { z } from "zod";

import { ownerName } from "@/lib/agent/owner";

/**
 * 0015 Part B — what page the user is on, as the agent's "this".
 * Pages register a small context (kind, id, title, selection); the
 * panel reads it at SEND time and it becomes a system note on the turn
 * (metadata on the user row, never searchable text). Ids, not page
 * contents: the agent fetches what it needs with get_machine / inspect,
 * so the note stays tiny and current.
 *
 * Pure — imported by the client provider, the chat route, and the
 * workflow bundle.
 */

export const PAGE_CONTEXT_KINDS = [
  "machine",
  "chat",
  "project",
  "sandbox",
  "inbox",
  "previews",
  "other",
] as const;

export type PageContextKind = (typeof PAGE_CONTEXT_KINDS)[number];

/** What a page registers (path is added by the provider). */
export const viewingContextSchema = z
  .object({
    kind: z.enum(PAGE_CONTEXT_KINDS),
    /** The page's primary id, when it has one (machine id, mr_…, c_…, p_…, sbx_…). */
    id: z.string().max(120).optional(),
    /** The project a page sits under, when it is inside one. */
    projectId: z.string().max(120).optional(),
    /** The page's human title (machine name, run title, chat title). */
    title: z.string().max(200).optional(),
    /** What is selected, as a short phrase ("stage lint", "transition verify → implement"). */
    selection: z.string().max(200).optional(),
    /** Run view: the run's status and current stage. */
    runStatus: z.string().max(40).optional(),
    currentStage: z.string().max(60).optional(),
    /** The route path (added by the provider at read time). */
    path: z.string().max(300).optional(),
  })
  .strict();

export type ViewingContext = z.infer<typeof viewingContextSchema>;

/** Validate an untrusted context (the chat route's request body). */
export function parseViewingContext(value: unknown): ViewingContext | null {
  const parsed = viewingContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Prefix the injected system note carries, so tests and eyes find it. */
export const VIEWING_NOTE_PREFIX = "[viewing]";

/**
 * The system-note text the model sees on a send. Short on purpose —
 * the note travels with the message forever (rebuilt from row metadata
 * every turn), and the agent resolves ids with its tools.
 */
export function viewingNote(viewing: ViewingContext): string {
  const what =
    `${viewing.kind}${viewing.title ? ` "${viewing.title}"` : ""}` +
    (viewing.id ? ` (\`${viewing.id}\`)` : "");
  const details = [
    viewing.path ? `at ${viewing.path}` : null,
    viewing.selection ? `selected: ${viewing.selection}` : null,
    viewing.runStatus ? `status: ${viewing.runStatus}` : null,
    viewing.currentStage ? `current stage: ${viewing.currentStage}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const fetch =
    viewing.kind === "machine"
      ? "get_machine"
      : viewing.kind === "chat" || viewing.kind === "sandbox"
        ? "inspect"
        : null;
  return (
    `${VIEWING_NOTE_PREFIX} ${ownerName()} is viewing ${what}${details ? ` — ${details}` : ""}. ` +
    `"This" and "it" refer to it${fetch ? `; read details with ${fetch}` : ""}.`
  );
}
