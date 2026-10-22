"use client";

import { Bot, ExternalLink, MessageSquarePlus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PhaseChip } from "@/components/status-chip";
import { ChatSession } from "@/components/chat-session";
import { PreviewPill } from "@/components/previews/preview-pill";
import { usePageContextReader } from "@/components/page-context";
import { rowsToUIMessages, type StoredRow } from "@/lib/chat-ui";
import { extendChatPageBack } from "@/lib/chat-fetch";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ChatRoute } from "@/lib/providers/route";

/**
 * 0015 Part B — the always-available agent panel: an ordinary chat
 * (ChatSession) in a right-side frame in the root layout, so it stays
 * open across navigation. Opened by the sidebar's Agent button (0040;
 * it dispatches OPEN_PANEL_EVENT, also the way the mobile drawer reaches
 * it) and toggled with ⌘J / Ctrl-J; the floating bottom-right button is
 * gone. It pushes the page on lg+, overlays below it, and is a
 * full-screen sheet below md. The panel shows one current conversation
 * (its id in localStorage); New starts a fresh one and Open full page
 * goes to /c/<id>.
 *
 * Scope rules (0015 + 0013): a conversation created from the panel
 * binds to the project of the page the creating send happens on (the
 * page context carries it; the route binds once) and never switches.
 * Every send carries the page context as the turn's viewing note, so
 * "this" works anywhere. An open panel marks its conversation seen
 * (ChatSession's useMarkSeen — visible + focused tab).
 */

/** Dispatched on `window` to open the panel (the mobile drawer's entry). */
export const OPEN_PANEL_EVENT = "sweatshop:open-agent-panel";
const OPEN_KEY = "sweatshop.panel.open";
const CONVERSATION_KEY = "sweatshop.panel.conversation";
const WIDTH_KEY = "sweatshop.panel.width";
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 320;
const MAX_WIDTH = 640;

/** 0075: rows in the hydrated tail window (same as the page frame). */
const HYDRATE_TAIL = 150;

interface PanelHydration {
  /** The conversation this hydration is for. */
  id: string;
  messages: ReturnType<typeof rowsToUIMessages>;
  activeRunId: string | null;
  /** 0077: the live run's resume cursor. */
  activeStreamCursor: number | null;
  route: ChatRoute | null;
  projectId: string | null;
  title: string | null;
  /** 0075: the tail window's older-page cursor / remaining count. */
  olderCursor: number | null;
  olderRemaining: number;
}

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* private mode etc. — the panel still works per-tab */
  }
}

/**
 * The mounted session's lifecycle. The ChatSession instance must live
 * as long as the conversation does: its transport reconnects to a live
 * turn only while its useChat instance survives, so adoption NEVER
 * remounts or re-keys it (the session self-adopts — same id). Remounts
 * happen only when the conversation truly changes: New (a fresh client
 * id) or reopening the panel on a stored conversation (hydrated first,
 * because initialMessages/activeRunId are init-only props).
 */
type PanelMode =
  /** A stored conversation is being fetched before its session mounts. */
  | "hydrating"
  /** Mounted on the hydrated stored conversation. */
  | "stored"
  /** Mounted fresh (no conversation yet; self-adopts on first send). */
  | "fresh";

export function AgentPanel() {
  const router = useRouter();
  const readPageContext = usePageContextReader();

  const [open, setOpen] = useState(() => stored(OPEN_KEY) === "1");
  const [conversationId, setConversationId] = useState(() => stored(CONVERSATION_KEY));
  const [mode, setMode] = useState<PanelMode>(() => (stored(CONVERSATION_KEY) ? "hydrating" : "fresh"));
  const [hydration, setHydration] = useState<PanelHydration | null>(null);
  // The title of a conversation adopted live this open (best-effort
  // fetch; the stored path gets it from hydration).
  const [liveTitle, setLiveTitle] = useState<string | null>(null);
  // Bumped by New so the fresh ChatSession gets a brand-new client id.
  const [nonce, setNonce] = useState(0);
  const [width, setWidth] = useState(() => {
    const saved = Number(stored(WIDTH_KEY));
    return Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : DEFAULT_WIDTH;
  });

  const openPanel = () => {
    setOpen(true);
    store(OPEN_KEY, "1");
  };

  /** Closing unmounts the session; the next open rehydrates the stored
   *  conversation (it may have grown) or starts fresh. */
  const closePanel = () => {
    setOpen(false);
    store(OPEN_KEY, "0");
    setHydration(null);
    setLiveTitle(null);
    setMode(conversationId ? "hydrating" : "fresh");
  };

  const togglePanel = () => (open ? closePanel() : openPanel());

  // ⌘J / Ctrl-J toggles from anywhere (⌘K stays the palette). The
  // listener registers once; the handler rides a ref so it stays current.
  const toggleRef = useRef(togglePanel);
  useEffect(() => {
    toggleRef.current = togglePanel;
  });
  // Other surfaces (the mobile nav drawer) open the panel by event rather
  // than sharing state — the panel stays the one owner of its lifecycle.
  const openRef = useRef(openPanel);
  useEffect(() => {
    openRef.current = openPanel;
  });
  useEffect(() => {
    const onOpen = () => openRef.current();
    window.addEventListener(OPEN_PANEL_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PANEL_EVENT, onOpen);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Fetch the stored conversation before its session mounts. "hydrating"
  // is only ever entered with a conversation id (init, closePanel), so
  // no id here means nothing to do. 0075: the tail window hydrates like
  // the page frame's — newest HYDRATE_TAIL rows, paged back to the live
  // turn's opening t_ row when a turn is live (the stream replay
  // supplies the turn itself).
  useEffect(() => {
    if (!open || mode !== "hydrating" || !conversationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/x/chat?conversationId=${encodeURIComponent(conversationId)}&tail=${HYDRATE_TAIL}`,
          { cache: "no-store" },
        );
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          messages: StoredRow[];
          activeRunId: string | null;
          activeStreamCursor: number | null;
          route: ChatRoute | null;
          projectId: string | null;
          title: string | null;
          olderCursor: number | null;
          olderRemaining: number;
        };
        if (cancelled) return;
        let page = {
          rows: body.messages ?? [],
          activeRunId: body.activeRunId,
          activeStreamCursor: body.activeStreamCursor ?? null,
          olderCursor: body.olderCursor ?? null,
          olderRemaining: body.olderRemaining ?? 0,
        };
        // 0077: a live turn hydrates from its persisted slices, same as
        // the page frame — the session resumes the run's own durable
        // stream from `activeStreamCursor` for the rest. Walk the page
        // back to a t_ opener so the window head is fold-aligned (0076
        // review finding 5; a mid-fold head is the precondition for
        // merge corruption).
        if (!cancelled && page.rows.length > 0 && !page.rows.some((row) => row.id.startsWith("t_"))) {
          page = await extendChatPageBack(conversationId, page, HYDRATE_TAIL, (rows) =>
            rows.some((row) => row.id.startsWith("t_")),
          );
        }
        if (cancelled) return;
        const rows = page.rows;
        setHydration({
          id: conversationId,
          messages: rowsToUIMessages(rows),
          activeRunId: body.activeRunId,
          activeStreamCursor: body.activeStreamCursor ?? null,
          route: body.route,
          projectId: body.projectId,
          title: body.title,
          olderCursor: page.olderCursor,
          olderRemaining: page.olderRemaining,
        });
        setMode("stored");
      } catch {
        /* transient — closing and reopening the panel retries */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mode, conversationId]);

  /** First send created the conversation: record it — NEVER remount the
   *  live session (its id already IS the conversation's). */
  const handleAdopted = (id: string) => {
    setConversationId(id);
    store(CONVERSATION_KEY, id);
    // The sidebar gains the conversation (server-rendered shell).
    router.refresh();
    // Best-effort title for the header.
    void fetch(`/api/x/chat?conversationId=${id}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ title: string | null }>) : null))
      .then((body) => {
        if (body) setLiveTitle(body.title);
      })
      .catch(() => undefined);
  };

  const handleNew = () => {
    setConversationId(null);
    setHydration(null);
    setLiveTitle(null);
    setNonce((n) => n + 1);
    setMode("fresh");
    store(CONVERSATION_KEY, null);
  };

  // ── Resize (lg+; below that the panel overlays or covers) ────────────
  const dragging = useRef(false);
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
  };
  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX));
    setWidth(next);
  };
  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    store(WIDTH_KEY, String(width));
  };

  const title = mode === "stored" ? hydration?.title : liveTitle;
  const sessionHeader = (s: Parameters<NonNullable<Parameters<typeof ChatSession>[0]["header"]>>[0]) => (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2.5">
      <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
        {title ?? (s.adopted ? "Agent" : "New chat")}
      </span>
      <PhaseChip phase={s.phase} className="max-sm:hidden" />
      <PreviewPill owner={s.started ? s.conversationId : null} compact />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="New chat"
        title="New chat"
        onClick={handleNew}
      >
        <MessageSquarePlus />
      </Button>
      {s.adopted && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open full page"
          title="Open full page"
          asChild
        >
          <Link href={`/c/${s.conversationId}`}>
            <ExternalLink />
          </Link>
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close panel"
        title="Close (⌘J)"
        onClick={closePanel}
      >
        <X />
      </Button>
    </div>
  );

  return (
    <>
      {open && (
        <aside
          aria-label="Agent panel"
          className={cn(
            "flex h-dvh shrink-0 flex-col border-l bg-background",
            // Below lg the panel overlays the page; below md it is a
            // full-screen sheet (w-full! beats the inline width).
            "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:shadow-2xl",
            "max-md:w-full!",
          )}
          style={{ width }}
        >
          {/* Drag to resize (the pushed layout only). */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="absolute top-0 bottom-0 -left-1 z-10 hidden w-2 cursor-col-resize lg:block"
          />

          {mode === "fresh" ? (
            <ChatSession
              key={`fresh-${nonce}`}
              frameId="panel"
              className="flex-1"
              pageContext={readPageContext}
              onAdopted={handleAdopted}
              header={sessionHeader}
            />
          ) : mode === "stored" && hydration?.id === conversationId && conversationId ? (
            <ChatSession
              key={conversationId}
              frameId="panel"
              className="flex-1"
              conversationId={conversationId}
              initialMessages={hydration.messages}
              activeRunId={hydration.activeRunId}
              activeStreamCursor={hydration.activeStreamCursor}
              initialRoute={hydration.route}
              projectId={hydration.projectId ?? undefined}
              olderCursor={hydration.olderCursor}
              olderRemaining={hydration.olderRemaining}
              pageContext={readPageContext}
              onAdopted={handleAdopted}
              header={sessionHeader}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Loading conversation…
            </div>
          )}
        </aside>
      )}
    </>
  );
}
