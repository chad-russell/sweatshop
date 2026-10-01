import {
  type AnySQLiteColumn,
  index,
  integer,
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
    /** 0007: user-visible folder; null = unfiled (Inbox). Must belong to
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
    /** Rows mirrored for this conversation (gap audit via rebuild). */
    eventCount: integer("event_count").notNull().default(0),
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
    at: integer("at").notNull(),
  },
  (table) => [index("messages_conversation_idx").on(table.conversationId)],
);

export type Folder = typeof folders.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type ConversationEvent = typeof conversationEvents.$inferSelect;
export type NewConversationEvent = typeof conversationEvents.$inferInsert;

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
 * 0004 Path B ticket runs: one row per run_ticket workflow execution,
 * updated by workflow steps; the UI polls it (the db IS the run status).
 */
export const ticketRuns = sqliteTable("ticket_runs", {
  /** Generated by the trigger; also the approval-hook token. */
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  ticket: text("ticket").notNull(),
  /** planning | awaiting-approval | implementing | qa | finishing |
   *  completed | rejected | failed */
  status: text("status").notNull(),
  /** Phase detail: plan text at the gate; error text on failure. */
  detail: text("detail"),
  branch: text("branch"),
  prUrl: text("pr_url"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type TicketRun = typeof ticketRuns.$inferSelect;

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
