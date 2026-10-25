import type { ChatStatus, UIMessage } from "ai";
import type { ReactNode } from "react";
import type { ChatRoute } from "@/lib/providers/route";
import type { SandboxOption } from "@/lib/api/sandboxes";
import type { ConversationSandboxViewData } from "@/components/sandbox-view";
import type { Phase } from "@/lib/thread-phase";
import type { DisplayWorkPR } from "@/lib/work-prs";

/** What the session tells its frame each render (header chrome, fresh-mode). */
export interface ChatSessionState {
  conversationId: string;
  /** True when the frame opened an existing conversation (`/c/<id>`). */
  adopted: boolean;
  /** A first send has happened — the conversation exists server-side. */
  started: boolean;
  /** Nothing sent yet on a new conversation (the machine-target moment). */
  fresh: boolean;
  /** 0021: the conversation's own route (null = project / global default). */
  route: ChatRoute | null;
  selectRoute: (route: ChatRoute | null) => void;
  sandboxChoice: string;
  setSandboxChoice: (choice: string) => void;
  sandboxes: SandboxOption[];
  loadSandboxes: () => void;
  sandboxView: ConversationSandboxViewData | null;
  /** A turn is running (submitted/streaming). */
  busy: boolean;
  status: ChatStatus;
  /** Forget the composer draft (a run start consumed the text). */
  clearDraft: () => void;
  /** 0041 (0078: PR-free now): the outline-derived work phase. */
  phase: Phase | null;
  /** 0078: every create_pr call in the transcript, with live state and
   *  diff breakdown — the header's work pill. */
  workPRs: DisplayWorkPR[];
  /** The live transcript — the work chip derives its live child set
   *  from it (lib/chat-ui.ts's backgroundChildIds). */
  messages: UIMessage[];
}

/** A frame's takeover of the fresh composer (the page frame's machine
 *  target, 0012). Everything is optional; absent means a plain chat. */
export interface FreshComposerMode {
  emptyState?: ReactNode;
  placeholder?: string;
  /** Rendered in the composer footer while fresh (the target picker). */
  footer?: ReactNode;
  /** Handle a fresh submit; return true when consumed (not sent as a chat). */
  onSubmit?: (text: string) => boolean;
  /** Extra busy state for the submit button (a run is starting). */
  busy?: boolean;
  /** An extra error line under the composer. */
  error?: string | null;
}

/** What a frame can drive on the session (New chat, focus). */
export interface ChatSessionController {
  reset: () => void;
  focus: () => void;
}
