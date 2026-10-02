"use client";

import { Bot, ExternalLink, MessageSquarePlus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChatSession } from "@/components/chat-session";
import { usePageContextReader } from "@/components/page-context";
import { rowsToUIMessages, type StoredRow } from "@/lib/chat-ui";
import { cn } from "@/lib/utils";

/**
 * 0015 Part B — the always-available agent panel: an ordinary chat
 * (ChatSession) in a right-side frame in the root layout, so it stays
 * open across navigation. Toggled by a floating bottom-right button and
 * ⌘J / Ctrl-J. It pushes the page on lg+, overlays below it, and is a
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

const OPEN_KEY = "sweatshop.panel.open";
const CONVERSATION_KEY = "sweatshop.panel.conversation";
const WIDTH_KEY = "sweatshop.panel.width";
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 320;
const MAX_WIDTH = 640;

interface PanelHydration {
  /** The conversation this hydration is for. */
  id: string;
  messages: ReturnType<typeof rowsToUIMessages>;
  activeRunId: string | null;
  modelId: string | null;
  projectId: string | null;
  title: string | null;
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

export function AgentPanel() {
  const router = useRouter();
  const readPageContext = usePageContextReader();

  const [open, setOpen] = useState(() => stored(OPEN_KEY) === "1");
  const [conversationId, setConversationId] = useState(() => stored(CONVERSATION_KEY));
  const [hydration, setHydration] = useState<PanelHydration | null>(null);
  // Bumped by New so the fresh ChatSession gets a brand-new client id.
  const [nonce, setNonce] = useState(0);
  const [width, setWidth] = useState(() => {
    const saved = Number(stored(WIDTH_KEY));
    return Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : DEFAULT_WIDTH;
  });

  const toggle = () => {
    setOpen((was) => {
      const next = !was;
      store(OPEN_KEY, next ? "1" : "0");
      return next;
    });
  };

  // ⌘J / Ctrl-J toggles from anywhere (⌘K stays the palette).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Hydrate the current conversation when the panel opens on one.
  useEffect(() => {
    if (!open || !conversationId || hydration?.id === conversationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/x/chat?conversationId=${conversationId}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          messages: StoredRow[];
          activeRunId: string | null;
          modelId: string | null;
          projectId: string | null;
          title: string | null;
        };
        if (cancelled) return;
        setHydration({
          id: conversationId,
          messages: rowsToUIMessages(body.messages ?? []),
          activeRunId: body.activeRunId,
          modelId: body.modelId,
          projectId: body.projectId,
          title: body.title,
        });
      } catch {
        /* transient — reopening the panel retries */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, conversationId, hydration?.id]);

  const handleAdopted = (id: string) => {
    setConversationId(id);
    store(CONVERSATION_KEY, id);
    // The sidebar gains the conversation (server-rendered shell).
    router.refresh();
  };

  const handleNew = () => {
    setConversationId(null);
    setHydration(null);
    setNonce((n) => n + 1);
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

  const title = hydration?.id === conversationId && conversationId ? hydration.title : null;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={toggle}
          aria-label="Open agent panel (⌘J)"
          title="Agent panel (⌘J)"
          className="fixed right-4 bottom-4 z-40 inline-flex size-10 items-center justify-center rounded-full border border-border bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105"
        >
          <Bot className="size-5" aria-hidden />
        </button>
      )}

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

          <ChatSession
            key={`${nonce}:${conversationId ?? "fresh"}`}
            frameId="panel"
            conversationId={conversationId ?? undefined}
            initialMessages={hydration?.id === conversationId ? hydration.messages : undefined}
            activeRunId={hydration?.id === conversationId ? hydration.activeRunId : undefined}
            initialModelId={hydration?.id === conversationId ? hydration.modelId : undefined}
            projectId={hydration?.id === conversationId ? (hydration.projectId ?? undefined) : undefined}
            pageContext={readPageContext}
            onAdopted={handleAdopted}
            header={(s) => (
              <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2.5">
                <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
                  {title ?? (s.adopted ? "Agent" : "New chat")}
                </span>
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
                  onClick={toggle}
                >
                  <X />
                </Button>
              </div>
            )}
          />
        </aside>
      )}
    </>
  );
}
