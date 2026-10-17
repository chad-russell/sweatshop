/**
 * 0046: which status glyph a CHILD row in the conversation tree shows.
 * Pure — components/sidebar/child-glyph.tsx maps the kind to an icon.
 *
 * - harness call: spinner running, the harness's own mark (muted) once
 *   completed, ✕ failed, ⊘ cancelled.
 * - child thread (chat with a parent): spinner while a turn is live, ⚠
 *   when its last turn ran out of steps, else the generic agent mark.
 *   (Cancelled threads have no persisted signal — see docs/0046.)
 * - historical runs and top-level conversations: "none" here (runs keep
 *   RunGlyph unchanged).
 */
export type ChildGlyphKind =
  | "none"
  | "running"
  | "waiting"
  | "needs-attention"
  | "failed"
  | "cancelled"
  | "harness-done"
  | "agent-done";

export function childGlyphKind(item: {
  kind: string;
  runStatus: string | null;
  parentConversationId: string | null;
  activeRunId: string | null;
  threadStatus?: "exhausted" | null;
}): ChildGlyphKind {
  if (item.kind === "harness") {
    switch (item.runStatus) {
      case "running":
        return "running";
      case "completed":
        return "harness-done";
      case "failed":
        return "failed";
      case "waiting":
      case "needs-attention":
        return item.runStatus;
      default:
        return "cancelled";
    }
  }
  if (item.kind === "chat" && item.parentConversationId) {
    if (item.activeRunId) return "running";
    if (item.threadStatus === "exhausted") return "needs-attention";
    return "agent-done";
  }
  return "none";
}
