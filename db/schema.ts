import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * sweatshop's own store (0002). The conversations table is the app-level
 * index of eve sessions; conversation_events is the derived, append-only
 * mirror of each session's stream (see the dual-write invariants in
 * docs/0002: eve's stream is authoritative; this is a rebuildable
 * materialized view).
 */
export const conversations = sqliteTable(
  "conversations",
  {
    /** eve sessionId (wrun_...). */
    id: text("id").primaryKey(),
    /** First user message, trimmed (~60 chars); null until it arrives. */
    title: text("title"),
    /** Project this conversation is bound to at creation (0004);
     *  immutable for the session's life. */
    projectId: text("project_id").references(() => projects.id),
    /** 0007: one-line generated summary; null until generated. */
    summary: text("summary"),
    /** 0007: "auto" (first-message / generated) | "manual" (user rename,
     *  never overwritten). */
    titleSource: text("title_source").notNull().default("auto"),
    /** 0007: titles generated so far (0, 1, or 2 — see lib/titles.ts). */
    titleGenerations: integer("title_generations").notNull().default(0),
    /** 0010: the model this conversation runs (plain column — the
     *  header→principal-attribute plumbing is gone). Null = default. */
    modelId: text("model_id"),
    /** 0010: explicit sandbox choice (docs/0010 "knobs above the SDK
     *  layer"): null = the default (dedicated, lazy, project
     *  conversations), "none" = no sandboxed tools, or
     *  "attached:<sandboxId>" to join another owner's sandbox. */
    sandboxPref: text("sandbox_pref"),
    /** 0007: user-visible folder; null = unfiled. Must belong to
     *  the same group (project) as the conversation. */
    folderId: text("folder_id").references((): AnySQLiteColumn => folders.id),
    /** 0007: Unix ms; hidden from folders/inbox, still searchable. */
    archivedAt: integer("archived_at"),
    /** 0007: Unix ms; hidden everywhere but Trash, not searchable. */
    trashedAt: integer("trashed_at"),
    /** Unix ms. */
    createdAt: integer("created_at").notNull(),
    /** Unix ms, bumped on each newly mirrored event. */
    updatedAt: integer("updated_at").notNull(),
    /** 0008 (inbox): Unix ms the user last viewed this conversation. A
     *  conversation is unread when it has an assistant message newer than
     *  this (db/attention.ts). 0 = never viewed. */
    lastSeenAt: integer("last_seen_at").notNull().default(0),
    /** Rows mirrored for this conversation (gap audit via rebuild). */
    eventCount: integer("event_count").notNull().default(0),
    /** 0010 spike: the conversation's running turn workflow (new chat
     *  runtime), null when idle. Route-set, cleared by the turn's
     *  persist step (or cancel). */
    activeRunId: text("active_run_id"),
  },
  (table) => [
    index("conversations_updated_at_idx").on(table.updatedAt),
    index("conversations_project_idx").on(table.projectId),
    index("conversations_folder_idx").on(table.folderId),
  ],
);

/**
 * 0007: user-created folders, scoped to a group — a project, or Chats
 * (project_id null). Free-form tree via parent_id; sibling-name
 * uniqueness and same-group/no-cycle rules are enforced in
 * db/organize.ts, not by constraints.
 */
export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey(),
    /** Owning group; null = the unbound "Chats" group. */
    projectId: text("project_id").references(() => projects.id),
    parentId: text("parent_id").references((): AnySQLiteColumn => folders.id),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("folders_project_idx").on(table.projectId),
    index("folders_parent_idx").on(table.parentId),
  ],
);

export const conversationEvents = sqliteTable(
  "conversation_events",
  {
    /**
     * The evt_ ULID from the event envelope's meta.id — stable across
     * reconnects and replays, so ON CONFLICT DO NOTHING is the correct
     * idempotent ingest (per eve's envelope docs). ULIDs are broadly
     * time-ordered, keeping inserts clustered. Ingestion order is the
     * implicit rowid.
     */
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    /** Loose event type (message.received, step.completed, ...). */
    type: text("type").notNull(),
    /** Raw JSON envelope, stored schemaless to survive eve drift. */
    event: text("event").notNull(),
    /** Unix ms from meta.at. */
    at: integer("at").notNull(),
  },
  (table) => [
    index("conversation_events_conversation_idx").on(table.conversationId),
    // 0008: the inbox scans the (few) input.* events by type.
    index("conversation_events_type_idx").on(table.type),
  ],
);

/**
 * Extracted conversation text (0003): one row per user message
 * (`message.received`) or finalized assistant block (`message.completed`),
 * keyed on the event ULID so extraction is idempotent. `messages_fts`
 * (defined in the migration, not here — drizzle has no FTS5 type) is an
 * external-content index over this table kept in sync by triggers.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    /** "user" | "assistant". */
    role: text("role").notNull(),
    text: text("text").notNull(),
    /** 0010 spike: serialized ModelMessage this row came from (new chat
     *  runtime); null on mirror-extracted rows. The new runtime's source
     *  of truth — `text` stays the plain-text extraction for search. */
    modelMessage: text("model_message"),
    at: integer("at").notNull(),
  },
  (table) => [index("messages_conversation_idx").on(table.conversationId)],
);

/**
 * 0010 spike: steer messages queued while a turn is running (or before
 * the next one starts). Drained by the running turn's prepareStep (mid-
 * turn) or folded into the next turn's loaded history.
 */
export const steerQueue = sqliteTable(
  "steer_queue",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("steer_queue_conversation_idx").on(table.conversationId)],
);

export type Folder = typeof folders.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type ConversationEvent = typeof conversationEvents.$inferSelect;
export type NewConversationEvent = typeof conversationEvents.$inferInsert;

/**
 * 0010 Phase 2: sandboxes as explicit, provider-agnostic resources.
 * A row is a live lease — created on first acquire, updated on stop/
 * resume, DELETED on destroy (this is a registry, not an audit log; run
 * and harness history live in their own tables). `ref` is opaque to
 * everything above the SandboxProvider seam (podman container name
 * today, a VM id later). One dedicated sandbox per owner.
 */
export const sandboxes = sqliteTable(
  "sandboxes",
  {
    /** sbx_… */
    id: text("id").primaryKey(),
    /** SandboxProvider kind, e.g. "podman". */
    provider: text("provider").notNull(),
    /** Provider-opaque reference (container name today). */
    ref: text("ref").notNull(),
    /** "conversation" | "machine_run". */
    ownerKind: text("owner_kind").notNull(),
    ownerId: text("owner_id").notNull(),
    projectId: text("project_id").references(() => projects.id),
    /** "creating" | "running" | "stopped" | "destroyed" (0011: soft —
     *  the row stays so past calls still point at it). */
    status: text("status").notNull(),
    /** 0011: Unix ms when the sandbox was destroyed; null while live. */
    destroyedAt: integer("destroyed_at"),
    /** Unix ms; bumped on every acquire (idle reaping's signal). */
    lastUsedAt: integer("last_used_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    // 0011: unique among LIVE sandboxes only, so an owner whose sandbox
    // was destroyed can get a fresh one while the old row stays as history.
    uniqueIndex("sandboxes_owner_idx")
      .on(table.ownerKind, table.ownerId)
      .where(sql`${table.status} != 'destroyed'`),
    index("sandboxes_status_idx").on(table.status),
  ],
);

/**
 * 0010 Phase 3b: a conversation's harness session continuity — the
 * `resumeFrom` handle from @ai-sdk/workflow-harness, persisted after
 * each harness tool call so the next call resumes the same harness
 * session with prior context (replacing eve's in-memory session cache).
 */
export const chatHarnessState = sqliteTable(
  "chat_harness_state",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    /** "pi" | "claude". */
    harness: text("harness").notNull(),
    /** Serialized HarnessV1ResumeSessionState. */
    resumeFrom: text("resume_from").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.harness] }),
    index("chat_harness_state_idx").on(table.conversationId),
  ],
);

/**
 * 0010 Phase 4: human input pending on the new chat runtime. Written by
 * the ask_chad tool (via a workflow step — workflow context cannot touch
 * sqlite), resolved by the resume route. The inbox derives "needs you"
 * from these rows for new-runtime conversations (0008's
 * derived-from-mirror approach retires with the mirror).
 */
export const pendingInputs = sqliteTable(
  "pending_inputs",
  {
    /** The hook token (= the tool call id). */
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    kind: text("kind").notNull(),
    /** The question/approval payload shown on the card. */
    question: text("question").notNull(),
    createdAt: integer("created_at").notNull(),
    /** Null while pending; set when answered. */
    resolvedAt: integer("resolved_at"),
    /** Serialized answer (approved/comment), once resolved. */
    answer: text("answer"),
  },
  (table) => [index("pending_inputs_conversation_idx").on(table.conversationId)],
);

/**
 * 0010 Phase 2: a conversation attached to a sandbox it does not own
 * (explicit "join" from the composer dropdown or an agent tool). The
 * attacher works in its own workdir but shares ports and processes.
 */
export const sandboxAttachments = sqliteTable(
  "sandbox_attachments",
  {
    sandboxId: text("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    /** Workdir inside the sandbox: /work/<conversationId>. */
    workdir: text("workdir").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("sandbox_attachments_idx").on(table.sandboxId, table.conversationId),
    index("sandbox_attachments_conversation_idx").on(table.conversationId),
  ],
);

/**
 * 0011: which sandbox each sandboxed tool call actually ran in, keyed by
 * the AI SDK toolCallId. Written when the call acquires its sandbox, so
 * it records what happened, not what the conversation's pref said.
 */
export const sandboxCalls = sqliteTable(
  "sandbox_calls",
  {
    toolCallId: text("tool_call_id").primaryKey(),
    sandboxId: text("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    /** "bash" | "pi" | "claude". */
    tool: text("tool").notNull(),
    /** "dedicated" | "attached". */
    via: text("via").notNull(),
    /** Workdir inside the sandbox: /work/<conversationId>. */
    workdir: text("workdir").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [
    index("sandbox_calls_sandbox_idx").on(table.sandboxId),
    index("sandbox_calls_conversation_idx").on(table.conversationId),
  ],
);

/**
 * 0004 — projects & sandboxes. Projects break up types of work; a
 * project is defined by one or more git repos, references a shareable
 * sandbox config, and its repos' remotes resolve credentials by host.
 * Ids are human-readable slugs (seed-script-managed for now).
 */
export const sandboxConfigs = sqliteTable("sandbox_configs", {
  /** Slug, e.g. "default". */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Sandbox provider, e.g. "docker". */
  provider: text("provider").notNull().default("docker"),
  /** Optional image override; unset = provider default (eve's image). */
  imageRef: text("image_ref"),
  /** Coarse egress policy for live sandbox containers. */
  networkPolicy: text("network_policy").notNull().default("allow-all"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
});

export const projects = sqliteTable("projects", {
  /** Slug, e.g. "sweatshop". */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  /** FK sandbox_configs.id; null = the "default" config. */
  sandboxConfigId: text("sandbox_config_id").references(
    () => sandboxConfigs.id,
  ),
  createdAt: integer("created_at").notNull(),
});

export const projectRepos = sqliteTable(
  "project_repos",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    /** https or ssh remote URL. */
    url: text("url").notNull(),
    /** Directory name under /workspace. */
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("project_repos_project_idx").on(table.projectId)],
);

/**
 * Credentials resolve by git host (0004 refinement 1): a github kind
 * matches github.com, a forgejo kind matches its instance host. Multiple
 * accounts per host are out of scope. Secret is plaintext per decision 3
 * (LAN-only personal tool; reversible via re-encryption migration).
 */
export const gitCredentials = sqliteTable("git_credentials", {
  /** Slug, e.g. "github-chad". */
  id: text("id").primaryKey(),
  /** "github" | "forgejo" — selects the GitHost implementation. */
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  username: text("username").notNull(),
  secret: text("secret").notNull(),
  /** Instance base URL (forgejo); null for github. */
  baseUrl: text("base_url"),
  createdAt: integer("created_at").notNull(),
});

export type SandboxConfig = typeof sandboxConfigs.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ProjectRepo = typeof projectRepos.$inferSelect;
export type GitCredential = typeof gitCredentials.$inferSelect;


/**
 * 0005 harness visibility: the pi (and future harness) event stream per
 * conversation — every model step, tool call, input, and output. Written
 * by the pi tool from the eve runtime; read by /api/harness/[sessionId]
 * from the Next server — sqlite (WAL) is the cross-process transport.
 */
export const harnessEvents = sqliteTable(
  "harness_events",
  {
    /** AUTOINCREMENT rowid — ingestion order. */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** eve sessionId of the owning conversation. */
    sessionId: text("session_id").notNull(),
    /** Harness discriminator — "pi" | "claude" (0006). Pre-0006 rows are pi. */
    harness: text("harness").notNull().default("pi"),
    at: integer("at").notNull(),
    kind: text("kind").notNull(),
    toolName: text("tool_name"),
    input: text("input"),
    output: text("output"),
    text: text("text"),
  },
  (table) => [
    index("harness_events_session_idx").on(table.sessionId, table.harness),
  ],
);

/**
 * One row per harness per conversation (0006): the index the UI reads for
 * status and the /h/[sessionId]/[harness] view validates against.
 */
export const harnessRuns = sqliteTable(
  "harness_runs",
  {
    /** eve sessionId of the owning conversation; one row per (session,
     *  harness) via the unique index below (rowid table — composite
     *  primary keys trip drizzle-kit 0.31's snapshot generator). */
    sessionId: text("session_id").notNull(),
    /** Harness discriminator — same meaning as harness_events.harness. */
    kind: text("kind").notNull(),
    /** "running" | "completed" | "failed". */
    status: text("status").notNull(),
    toolCalls: integer("tool_calls").notNull().default(0),
    startedAt: integer("started_at").notNull(),
    lastAt: integer("last_at").notNull(),
    /** Bounded, redacted failure description; null on success (0006). */
    error: text("error"),
  },
  (table) => [
    uniqueIndex("harness_runs_session_kind_idx").on(
      table.sessionId,
      table.kind,
    ),
  ],
);

/**
 * 0009 machines: user-editable stage machines. `definition` is the
 * zod-validated JSON (lib/machines/definition); `version` bumps on every
 * definition change. Runs freeze a snapshot, so edits never touch an
 * in-flight run.
 */
export const machines = sqliteTable("machines", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  /** JSON MachineDefinition. */
  definition: text("definition").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type MachineRow = typeof machines.$inferSelect;

/**
 * One row per machine run (0009). The db IS the run status the UI
 * reads; the Workflow SDK owns the durable execution.
 */
export const machineRuns = sqliteTable(
  "machine_runs",
  {
    /** mr_… — also the prefix of every stage-visit token. */
    id: text("id").primaryKey(),
    /** Source machine; null once that machine is deleted (the snapshot
     *  keeps the run self-describing). */
    machineId: text("machine_id").references(() => machines.id, {
      onDelete: "set null",
    }),
    machineName: text("machine_name").notNull(),
    machineVersion: integer("machine_version").notNull(),
    /** JSON MachineDefinition snapshot taken at start. */
    definition: text("definition").notNull(),
    /** Bound at run start for workspace: project machines. */
    projectId: text("project_id").references(() => projects.id),
    prompt: text("prompt").notNull(),
    /** running | waiting | needs-attention | completed | failed | cancelled */
    status: text("status").notNull(),
    currentStage: text("current_stage"),
    containerName: text("container_name"),
    /** Bounded failure / parking reason. */
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("machine_runs_created_idx").on(table.createdAt)],
);

export type MachineRun = typeof machineRuns.$inferSelect;

/**
 * One row per stage visit (0009). `sessionId` is the stage's
 * conversation: the harness session key (`mr_<run>_<seq>`, which
 * harness_events / harness_runs and /h/<harness>/<id> use unchanged) or
 * the eve session id. Visit tokens are `<runId>:<seq>`.
 */
export const machineStageRuns = sqliteTable(
  "machine_stage_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => machineRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    stageId: text("stage_id").notNull(),
    /** harness | eve | human */
    kind: text("kind").notNull(),
    /** pi | claude for harness stages. */
    harness: text("harness"),
    /** running | waiting | completed | failed | parked */
    status: text("status").notNull(),
    sessionId: text("session_id"),
    /** Clipped final text (agents) or the human's comment. */
    outcome: text("outcome"),
    transitionTo: text("transition_to"),
    steps: integer("steps").notNull().default(0),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (table) => [
    uniqueIndex("machine_stage_runs_run_seq_idx").on(table.runId, table.seq),
  ],
);

export type MachineStageRun = typeof machineStageRuns.$inferSelect;
