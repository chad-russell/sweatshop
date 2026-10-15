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
 * index of conversations (chat runtime ids `c_…`; imported eve-era ids
 * `wrun_…` — their history lives in `messages`; the eve event mirror was
 * retired by 0032).
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
    /** 0021: the conversation's route (JSON ChatRoute — provider +
     *  model), set by the chat's model picker; what its turns and its
     *  pi tool calls inherit. Null = the project / global default. */
    route: text("route"),
    /** 0013 binding: the sandbox this conversation runs in — null until
     *  bound (a project chat binds on its first sandboxed call, an
     *  attacher at creation), then fixed for the conversation's life. */
    sandboxId: text("sandbox_id").references((): AnySQLiteColumn => sandboxes.id),
    /** 0013: the bound working directory (the target's, when attached). */
    sandboxWorkDir: text("sandbox_work_dir"),
    /** 0013: 1 = this conversation owns the bound sandbox's lifecycle;
     *  0 = attached (never stops or destroys it). */
    sandboxOwner: integer("sandbox_owner", { mode: "boolean" }),
    /** 0013: chosen "no sandbox" at creation — no sandboxed tools. */
    sandboxDisabled: integer("sandbox_disabled", { mode: "boolean" }).notNull().default(false),
    /** 0007: user-visible folder; null = unfiled. Must belong to
     *  the same group (project) as the conversation. */
    folderId: text("folder_id").references((): AnySQLiteColumn => folders.id),
    /** 0007: Unix ms; hidden from folders/inbox, still searchable. */
    archivedAt: integer("archived_at"),
    /** 0007: Unix ms; hidden everywhere but Trash, not searchable. */
    trashedAt: integer("trashed_at"),
    /** Unix ms. */
    createdAt: integer("created_at").notNull(),
    /** Unix ms, bumped on new activity. */
    updatedAt: integer("updated_at").notNull(),
    /** 0008 (inbox): Unix ms the user last viewed this conversation. A
     *  conversation is unread when it has an assistant message newer than
     *  this (db/attention.ts). 0 = never viewed. */
    lastSeenAt: integer("last_seen_at").notNull().default(0),
    /** 0010 spike: the conversation's running turn workflow (new chat
     *  runtime), null when idle. Route-set, cleared by the turn's
     *  persist step (or cancel). */
    activeRunId: text("active_run_id"),
    /** 0012: "chat" | "run" (a machine run — the id IS the machine_runs
     *  id) | "stage" (a run's per-visit agent conversation, hidden from
     *  the sidebar, unread, and search results). */
    kind: text("kind").notNull().default("chat"),
    /** 0039: the thread skill this conversation runs (skills/<id>/SKILL.md,
     *  null = a plain chat. Its body joins the turn instructions and
     *  raises the turn's step budget. */
    skill: text("skill"),
    /** 0037 phase 3: the chat whose start_thread created this thread —
     *  the wake target when this one settles. Null = not a child. A
     *  deleted parent goes null and wakes stop. */
    parentConversationId: text("parent_conversation_id").references(
      (): AnySQLiteColumn => conversations.id,
      { onDelete: "set null" },
    ),
    /** 0037 phase 3: the child's latest updated_at already delivered to
     *  its parent (wake-once-per-settle idempotency; the tick sweep
     *  re-fires anything missed — crash, restart). */
    wokenSettledAt: integer("woken_settled_at"),
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

/**
 * Extracted conversation text (0003): one row per user or assistant
 * message. `messages_fts` (defined in the migration, not here — drizzle
 * has no FTS5 type) is an external-content index over this table kept in
 * sync by triggers.
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
    /** 0015: JSON row metadata — the page-viewing context of a user
     *  message (a note chip in the transcript; never search text). */
    metadata: text("metadata"),
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

/**
 * 0042: images attached to chat messages. The bytes live on disk under
 * data/attachments (`<id>.<ext>`); the message row references the id.
 * An upload is unclaimed (`conversation_id` null) until a send claims it;
 * unclaimed rows older than 24 h are swept with their file. (0035's
 * screenshots are plain files with no row here.)
 */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    mediaType: text("media_type").notNull(),
    bytes: integer("bytes").notNull(),
    conversationId: text("conversation_id").references(() => conversations.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("attachments_conversation_idx").on(table.conversationId)],
);

export type Folder = typeof folders.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

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
    /** "conversation" | "machine_run" | "preview" (0016). */
    ownerKind: text("owner_kind").notNull(),
    ownerId: text("owner_id").notNull(),
    projectId: text("project_id").references(() => projects.id),
    /** "creating" | "running" | "stopped" | "destroyed" (0011: soft —
     *  the row stays so past calls still point at it). */
    status: text("status").notNull(),
    /** 0011: Unix ms when the sandbox was destroyed; null while live. */
    destroyedAt: integer("destroyed_at"),
    /** 0017/0019: when the project setup's `migrate` ran against this
     *  sandbox's services (once per sandbox); null = not yet. */
    migratedAt: integer("migrated_at"),
    /** 0017 amendment: when the setup's `seed` ran (once per sandbox,
     *  after migrate); independent marker — a sandbox migrated before
     *  `seed` existed still seeds. */
    seededAt: integer("seeded_at"),
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
    /** 0037: runtime-built evidence for the card (JSON `ApprovalEvidence`
     *  — check results, screenshots); null for plain asks. */
    card: text("card"),
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
 * 0004 — projects & sandboxes. Projects break up types of work; a
 * project is defined by one or more git repos, and its repos' remotes
 * resolve credentials by host. Ids are human-readable slugs
 * (seed-script-managed for now).
 */
export const projects = sqliteTable("projects", {
  /** Slug, e.g. "sweatshop". */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  /** 0031: the image this project's sandboxes run (was a shareable
   *  sandbox_configs entity — never actually shared); unset = the
   *  provider default, `localhost/sweatshop-sandbox`. */
  imageRef: text("image_ref"),
  /** 0021: JSON ChatRoute — the project's default for chats, agent
   *  stages, and pi. Null = the global defaults. */
  defaultRoute: text("default_route"),
  /** 0023: the project's "done" command — machine verify stages run it
   *  (carried in the stage brief's "# Project" section). Null = verify
   *  falls back to the repo's own test script. */
  testCommand: text("test_command"),
  /** 0023: standing branch prefix for machine-authored branches
   *  (`<prefix>/<slug>`); a ticket/issue key in the run prompt wins. */
  branchPrefix: text("branch_prefix"),
  /** 0021: JSON ProviderId[] — null = every provider allowed. */
  allowedProviders: text("allowed_providers"),
  /** 0021: JSON ("pi" | "claude")[] — null = every harness allowed. */
  allowedHarnesses: text("allowed_harnesses"),
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

/**
 * 0043: a host this project's agent may operate on — the allow-list
 * behind the `exec` tool. `api_base` is informational only (where the
 * host's HTTP API lives, surfaced in the tool description); nothing
 * mechanical reads it. No `kind`: what a host IS comes from the
 * project's repos (their AGENTS.md/READMEs), never from here.
 * `host_key_fp` pins the SSH server key (TOFU on first connect).
 */
export const projectHosts = sqliteTable(
  "project_hosts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    /** Lowercase kebab — also names the credential env vars (0043). */
    name: text("name").notNull(),
    /** SSH target, `host` or `host:port` (prefer Nebula IPs). */
    address: text("address").notNull(),
    /** Remote user the command runs as. */
    user: text("user").notNull(),
    apiBase: text("api_base"),
    /** sha256:fingerprint of the pinned SSH host key, once connected. */
    hostKeyFp: text("host_key_fp"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("project_hosts_project_idx").on(table.projectId),
    uniqueIndex("project_hosts_project_name_uq").on(table.projectId, table.name),
  ],
);

/**
 * 0043: the audit trail — one row per approved `exec`, written BEFORE
 * the command runs and resolved after (a crash mid-command still shows
 * the attempt). `host_id` has NO foreign key on purpose: removing a
 * host deletes nothing historical, so the row denormalizes `host_name`
 * and survives the registry entry.
 */
export const hostCommands = sqliteTable(
  "host_commands",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    /** Registry id at write time; stale after the host row is removed. */
    hostId: text("host_id").notNull(),
    hostName: text("host_name").notNull(),
    command: text("command").notNull(),
    exitCode: integer("exit_code"),
    /** Combined clipped stdout+stderr, written at resolve. */
    output: text("output"),
    durationMs: integer("duration_ms"),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (table) => [index("host_commands_conversation_idx").on(table.conversationId)],
);

export type Project = typeof projects.$inferSelect;
export type ProjectRepo = typeof projectRepos.$inferSelect;
export type GitCredential = typeof gitCredentials.$inferSelect;
export type ProjectHost = typeof projectHosts.$inferSelect;
export type HostCommand = typeof hostCommands.$inferSelect;


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
    /** Pairs a tool-start with its tool-end/tool-error (null on pre-0025 rows). */
    toolCallId: text("tool_call_id"),
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
 * One row per machine run (0009). The db IS the run status the UI
 * reads; the Workflow SDK owns the durable execution.
 */
export const machineRuns = sqliteTable(
  "machine_runs",
  {
    /** mr_… — also the prefix of every stage-visit token. */
    id: text("id").primaryKey(),
    /** Null for every run now (0037 phase 5 deleted machines); kept
     *  because historical snapshots recorded one. */
    machineId: text("machine_id"),
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
    /** 0013 binding: the sandbox the whole run (every stage) runs in —
     *  its own (provisioned at start, `/work/<runId>`) or inherited from
     *  the chat that started it (same sandbox and directory). Null for
     *  workspace-free runs. */
    sandboxId: text("sandbox_id").references((): AnySQLiteColumn => sandboxes.id),
    sandboxWorkDir: text("sandbox_work_dir"),
    /** 0013: 1 = the run owns its sandbox's lifecycle; 0 = inherited. */
    sandboxOwner: integer("sandbox_owner", { mode: "boolean" }),
    /** Bounded failure / parking reason. */
    error: text("error"),
    /** 0012: Unix ms the run last entered a settled status (waiting,
     *  needs-attention, completed, failed) — its "unread" moment. */
    settledAt: integer("settled_at"),
    /** 0022: the chat whose start_machine created this run — the wake
     *  target when the run settles. Null (UI/API starts) = never wakes;
     *  a deleted parent goes null and wakes stop. */
    parentConversationId: text("parent_conversation_id").references(
      (): AnySQLiteColumn => conversations.id,
      { onDelete: "set null" },
    ),
    /** 0022: the run's latest settled_at already delivered to its parent
     *  (wake-once-per-settle idempotency; the tick sweep re-fires
     *  anything older — crash, restart). */
    wokenSettledAt: integer("woken_settled_at"),
    /** 0012: the Workflow SDK run executing this machine run (cancel). */
    workflowRunId: text("workflow_run_id"),
    /** 0021: JSON RunOverrides (`startRun({ overrides })`) — null = none. */
    overrides: text("overrides"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("machine_runs_created_idx").on(table.createdAt)],
);

export type MachineRun = typeof machineRuns.$inferSelect;

/**
 * 0022 cut 2: one row per background harness call (the chat pi/claude
 * tools). The call's identity for inspect/cancel; its execution is a
 * `harnessCall` workflow run. Agent-stage harness calls (inside machine
 * runs) are synchronous and have no row.
 */
export const harnessCalls = sqliteTable(
  "harness_calls",
  {
    /** hc_… */
    id: text("id").primaryKey(),
    /** The chat that started the call — also its wake target and the
     *  harness session id (cross-call continuity, 0010). */
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** pi | claude */
    kind: text("kind").notNull(),
    task: text("task").notNull(),
    /** running | completed | failed | cancelled */
    status: text("status").notNull(),
    /** Clipped final text (completed) — the wake's detail. */
    result: text("result"),
    error: text("error"),
    /** 0012/0022: the Workflow SDK run executing the call (cancel). */
    workflowRunId: text("workflow_run_id"),
    settledAt: integer("settled_at"),
    wokenSettledAt: integer("woken_settled_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("harness_calls_conversation_idx").on(table.conversationId)],
);

export type HarnessCall = typeof harnessCalls.$inferSelect;

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
    /** 0021: JSON { route, layer } — what actually ran this visit and
     *  which layer it resolved from. Null for human gates (and pre-0021
     *  visits). */
    route: text("route"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (table) => [
    uniqueIndex("machine_stage_runs_run_seq_idx").on(table.runId, table.seq),
  ],
);

export type MachineStageRun = typeof machineStageRuns.$inferSelect;

/**
 * 0017 declared services: the sibling containers a sandbox owns per
 * its project setup (postgres, minio…). The substrate is the truth;
 * this row is the bookkeeping — same split as `sandboxes`. `ref` is
 * provider-opaque (container name on the podman backend).
 */
export const sandboxServices = sqliteTable(
  "sandbox_services",
  {
    /** ssvc_… */
    id: text("id").primaryKey(),
    sandboxId: text("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    /** The declared name (`${service:<name>:…}` references it). */
    name: text("name").notNull(),
    /** Declared image (snapshot for display). */
    image: text("image").notNull(),
    /** Provider-opaque reference; "" until created. */
    ref: text("ref").notNull().default(""),
    /** "creating" | "running" | "stopped" | "destroyed". */
    status: text("status").notNull().default("creating"),
    /** The declared port (readiness + display). */
    port: integer("port").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("sandbox_services_sandbox_name_idx").on(table.sandboxId, table.name)],
);

export type SandboxServiceRow = typeof sandboxServices.$inferSelect;

/**
 * 0016 previews: a long-running HTTP-serving process in a sandbox,
 * reachable at `pv-<slug>.<PREVIEW_BASE_DOMAIN>` through the preview
 * proxy. Owned by its SANDBOX, not by whatever started it — it outlives
 * the turn, run, or stage that called start_preview. The sandbox is the
 * source of truth for the process (pid/log files under
 * /work/.previews/); this row is the registry, reconciled by the tick.
 */
export const previews = sqliteTable(
  "previews",
  {
    /** pv_… */
    id: text("id").primaryKey(),
    /** DNS label suffix: the URL host is `pv-<slug>.<base>`. */
    slug: text("slug").notNull(),
    sandboxId: text("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    /** Absolute directory inside the sandbox the command runs in. */
    workDir: text("work_dir").notNull(),
    command: text("command").notNull(),
    port: integer("port").notNull(),
    /** Human label (branch name, app name). */
    label: text("label"),
    /** 0017: per-preview sparse env overrides (JSON map), merged over
     *  the project setup's env at launch; the platform's PORT/HOST/
     *  PREVIEW_* always win. Persisted so restarts reproduce the boot. */
    env: text("env"),
    /** "worktree" | "branch". */
    source: text("source").notNull(),
    /** branch sources: the project repo and branch followed. */
    repoId: text("repo_id").references(() => projectRepos.id),
    branch: text("branch"),
    /** branch sources: the commit currently served. */
    headSha: text("head_sha"),
    /** branch sources: the remote commit the follower last failed on;
     *  the Inbox item is keyed by it (a new failing sha is a new item). */
    failedSha: text("failed_sha"),
    /** branch sources: Chad dismissed the failure at this sha — hidden
     *  from the Inbox until a different sha fails. */
    dismissedSha: text("dismissed_sha"),
    /** "provisioning" | "starting" | "healthy" | "crashed" | "stopped" | "failed". */
    status: text("status").notNull(),
    /** Conversation / run / stage id that started it, or "user".
     *  Attribution only — never ownership. */
    startedBy: text("started_by").notNull(),
    /** Unix ms; stamped by the proxy (at most once a minute). */
    lastRequestAt: integer("last_request_at"),
    /** Bounded failure reason. */
    error: text("error"),
    /** Unix ms; null until deleted (the row stays as history). */
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("previews_slug_idx").on(table.slug).where(sql`${table.deletedAt} is null`),
    index("previews_sandbox_idx").on(table.sandboxId),
  ],
);

export type PreviewRow = typeof previews.$inferSelect;

/**
 * 0017 preview setups: one explicit run profile per project — where the
 * server lives in the repo, how deps install, what env and services a
 * preview needs. The definition is zod-validated JSON
 * (lib/previews/setup.ts), stored whole and upserted whole; one row per
 * project. Supersedes sandbox_configs.preview_command/preview_port.
 */
export const previewSetups = sqliteTable(
  "preview_setups",
  {
    /** psu_… */
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    definition: text("definition").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("preview_setups_project_idx").on(table.projectId)],
);

export type PreviewSetupRow = typeof previewSetups.$inferSelect;

/**
 * 0016 phase 3: a branch preview's follow history — one row per remote
 * commit the follower acted on (kept to the last few per preview).
 */
export const previewEvents = sqliteTable(
  "preview_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    previewId: text("preview_id")
      .notNull()
      .references(() => previews.id),
    sha: text("sha").notNull(),
    /** "deployed" | "reloaded" | "failed" | "reset". */
    result: text("result").notNull(),
    /** Bounded detail (failure reason, what ran). */
    detail: text("detail"),
    at: integer("at").notNull(),
  },
  (table) => [index("preview_events_preview_idx").on(table.previewId, table.at)],
);

/**
 * 0021: app settings — one JSON value per key. Today: the per-surface
 * default routes (`default_route.<surface>`); a missing row = the
 * built-in default (lib/providers/route.ts BUILTIN_DEFAULTS).
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * 0021: cached model catalogs for providers with a list API
 * (OpenRouter). Refreshed at most daily, or on demand from /settings.
 */
export const providerModels = sqliteTable(
  "provider_models",
  {
    provider: text("provider").notNull(),
    id: text("id").notNull(),
    label: text("label").notNull(),
    contextWindow: integer("context_window").notNull(),
    maxTokens: integer("max_tokens").notNull(),
    vision: integer("vision", { mode: "boolean" }).notNull().default(false),
    /** 0021 amendment: the model's reasoning control (null = none). */
    reasoning: text("reasoning"),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.id] })],
);
