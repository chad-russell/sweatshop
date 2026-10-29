/**
 * Attention / Inbox read-model shapes (queries live in @/db/attention) —
 * split per 0049.
 */
import type { ApprovalEvidence } from "../agent/tools/evidence";
import type { OutlineCard } from "../outline";
import type { AskOwnerCard } from "../question-form";

export interface PromptChangeCard {
  kind: "prompt_change";
  target:
    | { kind: "section"; key: "base" | "harness_steering" | "host_routing" }
    // 0088: save_skill cards reuse this shape.
    | { kind: "skill"; id: string };
  title: string;
  currentVersion: number;
  patch: { body?: string };
  before: { body?: string } | null;
  diff?: { op: "same" | "add" | "del"; text: string }[];
}

export interface RequestOption {
  id: string;
  label: string;
  description?: string;
  style?: "danger" | "default" | "primary";
}

export interface PendingRequest {
  requestId: string;
  kind: "tool-approval" | "question" | "outline";
  prompt: string;
  options: RequestOption[];
  allowFreeform: boolean;
  /** The tool call behind the request (approvals), when present. */
  toolName: string | null;
  toolInput: Record<string, unknown> | null;
  /** 0037: runtime-built evidence (check result, screenshots) for gated
   *  tools; null for plain asks. */
  evidence: ApprovalEvidence | null;
  /** 0064: the outline snapshot (outline reviews and accept_outline approvals). */
  outline: OutlineCard | null;
  /** 0043: an exec approval's structured ask (renders as a terminal
   *  block — host, command, timeout — instead of the JSON dump). */
  exec: {
    host: string;
    user: string;
    address: string;
    command: string;
    timeoutSec: number;
    /** The agent's "what this is for" line (absent on older rows). */
    description?: string;
  } | null;
  /** 0054: exact snapshot of an agent-proposed prompt/catalog change. */
  promptChange: PromptChangeCard | null;
  /** 0081: a structured ask_owner card (context + sub-questions),
   *  resolved (screenshot evidence already an attachment id/url); null
   *  for a legacy freeform ask_owner question or an approval with no
   *  context. */
  askOwner: AskOwnerCard | null;
  /** Unix ms the request was raised. */
  at: number;
}

export interface AttentionState {
  /** Live (not archived/trashed) conversations with unread assistant output. */
  unread: Set<string>;
  /** Conversations with ≥1 pending request (archived ones included —
   *  an approval blocks work whether or not the thread is filed away). */
  needsYou: Set<string>;
  /**
   * Changes iff anything the sidebar dots or the Inbox page show changed
   * (unread set, pending request ids, machine gates). Clients poll it
   * cheaply and refresh only on a difference.
   */
  signature: string;
}

export interface Where {
  projectName: string | null;
  /** Folder breadcrumb, e.g. ["Spikes", "Sandbox"]. */
  path: string[];
}

export interface NeedsYouThread extends Where {
  kind: "thread";
  id: string;
  title: string | null;
  /** Display label: title, else first user message, else "Untitled chat". */
  label: string;
  requests: PendingRequest[];
  /** Raised-at of the oldest pending request. */
  since: number;
  /** Also has unread assistant output (still shown once, here). */
  unread: boolean;
}

/** 0016: a branch preview the follower parked as failed (one per failing sha). */
export interface NeedsYouPreview {
  kind: "preview";
  /** `<previewId>:<failedSha>` — stable card key. */
  id: string;
  previewId: string;
  label: string;
  branch: string;
  sha: string;
  error: string;
  sandboxId: string;
  projectName: string | null;
  since: number;
}

export interface UnreadThread extends Where {
  id: string;
  kind: "chat";
  title: string | null;
  /** Display label: title, else first user message, else "Untitled chat". */
  label: string;
  /** Newest real assistant text (markdown kept), or an activity line. */
  snippet: string;
  /** Unix ms of that message. */
  at: number;
}

export interface InboxData {
  needsYou: (NeedsYouThread | NeedsYouPreview)[];
  unread: UnreadThread[];
}
