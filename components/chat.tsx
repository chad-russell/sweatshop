"use client";

import { BookOpen, Box, Check, ChevronsUpDown } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ConversationEmptyState } from "@/components/ai-elements/conversation";
import { AppHeader } from "@/components/app-header";
import {
  ChatSession,
  type ChatSessionController,
  type FreshComposerMode,
  type SandboxOption,
} from "@/components/chat-session";
import { usePageContext } from "@/components/page-context";
import { FreshTargetPicker, useSkills } from "@/components/fresh-target-picker";
import { LocalTime } from "@/components/local-time";
import { PreviewPill } from "@/components/previews/preview-pill";
import { PhaseChip } from "@/components/plan-card";
import { shortSandboxId } from "@/lib/sandbox-id";
import { type ConversationSandboxViewData } from "@/components/sandbox-view";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RoutePicker, shortRouteLabel, useModelsView } from "@/components/route-picker";
import type { ChatRoute } from "@/lib/providers/route";
import { cn } from "@/lib/utils";

/**
 * The chat page frame (0010 Phase 4; split in 0015 Phase 3): the
 * AppHeader with the model and sandbox pickers, URL behaviour (adopting
 * `/c/<id>` on first send, ⌘⇧O new chat), and the fresh composer's
 * skill target (0039). The transcript, composer and transport
 * live in ChatSession, which this frame and the agent panel share.
 */

/**
 * 0013: what the trigger says. A fresh conversation shows its pending
 * choice; a started one shows its binding (fixed for its life).
 */
function sandboxLabel(
  choice: string,
  editable: boolean,
  view: ConversationSandboxViewData | null,
  sandboxes: SandboxOption[],
  hasProject: boolean,
): string {
  if (editable) {
    if (choice === "none") return "no sandbox";
    if (choice.startsWith("attached:")) {
      const id = choice.slice("attached:".length);
      const label = sandboxes.find((s) => s.id === id)?.ownerLabel;
      return `attach: ${label ?? shortSandboxId(id)}`;
    }
    return hasProject ? "sandbox: new" : "no sandbox (no project)";
  }
  const state = view?.state;
  if (!state) return "sandbox";
  switch (state.kind) {
    case "none":
      return "no sandbox";
    case "unavailable":
      return "no sandbox (no project)";
    case "pending":
      return "sandbox: on first use";
    case "own":
      return `sandbox: ${shortSandboxId(state.sandboxId)}`;
    case "attached": {
      const label = view?.sandboxes[state.sandboxId]?.ownerLabel;
      return `attached: ${label ?? shortSandboxId(state.sandboxId)}`;
    }
  }
}

const SANDBOX_TRIGGER =
  "inline-flex h-8 pointer-coarse:h-10 max-w-48 items-center gap-1 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/** In the composer footer the pickers read as quiet text, not boxed buttons. */
const COMPOSER_PICKER = "min-w-0 shrink border-transparent px-2 max-w-40 sm:max-w-56";

/**
 * 0013 sandbox picker. Choosing happens once, on a fresh conversation:
 * its own new sandbox (created on first use), none, or attach to an
 * existing one — landing in that sandbox's own working directory. A
 * started conversation shows its binding read-only; switching sandboxes
 * means starting a new chat.
 */
function SandboxPicker({
  choice,
  editable,
  onSelect,
  onOpen,
  sandboxes,
  view,
  hasProject,
  className,
}: {
  choice: string;
  className?: string;
  /** Only a fresh conversation can choose. */
  editable: boolean;
  onSelect: (choice: string) => void;
  /** Fired each time the menu opens — refresh the attachable list. */
  onOpen: () => void;
  sandboxes: SandboxOption[];
  view: ConversationSandboxViewData | null;
  hasProject: boolean;
}) {
  const label = sandboxLabel(choice, editable, view, sandboxes, hasProject);

  if (!editable) {
    const state = view?.state;
    const bound = state?.kind === "own" || state?.kind === "attached" ? state : null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Sandbox"
            title="Where this conversation's bash / pi / claude calls run (fixed for this conversation)"
            className={cn(SANDBOX_TRIGGER, className)}
          >
            <span className="truncate">{label}</span>
            <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-1rem)]">
          <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
            <span className="text-xs font-medium text-foreground">{label}</span>
            {bound && (
              <span className="font-mono text-xs text-muted-foreground">{bound.workDir}</span>
            )}
            <span className="text-xs text-muted-foreground">
              {state?.kind === "pending"
                ? "This chat's own sandbox is created the first time a tool needs it."
                : state?.kind === "attached"
                  ? "Attached: same sandbox and directory as its owner, shared ports and processes."
                  : "Chosen when the chat started. Start a new chat to use a different sandbox."}
            </span>
          </DropdownMenuLabel>
          {bound && (
            <DropdownMenuItem asChild>
              <Link href={`/sandboxes/${bound.sandboxId}`} className="text-xs">
                <Box aria-hidden />
                Open sandbox {shortSandboxId(bound.sandboxId)}
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/sandboxes" className="text-xs text-muted-foreground">
              <Box aria-hidden />
              Manage sandboxes
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Sandbox"
          title="Where this conversation's bash / pi / claude calls will run — chosen once, now"
          className={cn(SANDBOX_TRIGGER, className)}
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-96 max-w-[calc(100vw-1rem)]">
        {hasProject && (
          <DropdownMenuItem onSelect={() => onSelect("auto")} className="items-start py-2">
            <Check
              className={cn("mt-0.5", choice === "auto" ? "opacity-100" : "opacity-0")}
              aria-hidden
            />
            <span className="flex flex-col">
              <span>New sandbox</span>
              <span className="text-xs font-normal text-muted-foreground">
                This chat&apos;s own, created on first use
              </span>
            </span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => onSelect(hasProject ? "none" : "auto")}
          className="items-start py-2"
        >
          <Check
            className={cn(
              "mt-0.5",
              choice === "none" || (!hasProject && choice === "auto") ? "opacity-100" : "opacity-0",
            )}
            aria-hidden
          />
          <span className="flex flex-col">
            <span>None</span>
            <span className="text-xs font-normal text-muted-foreground">No sandboxed tools</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          <span className="text-xs font-medium text-foreground">Attach to a sandbox</span>
          <span className="text-xs text-muted-foreground">
            Work in its directory, alongside its owner — same files, shared ports and processes.
            Fixed for this chat once you send.
          </span>
        </DropdownMenuLabel>
        {sandboxes.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No sandboxes to join yet.
          </div>
        )}
        {sandboxes.map((sandbox) => {
          const value = `attached:${sandbox.id}`;
          return (
            <DropdownMenuItem
              key={sandbox.id}
              onSelect={() => onSelect(value)}
              className="items-start py-2"
            >
              <Check
                className={cn("mt-0.5", value === choice ? "opacity-100" : "opacity-0")}
                aria-hidden
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{sandbox.ownerLabel}</span>
                <span className="flex flex-wrap items-center gap-x-1.5 text-xs font-normal text-muted-foreground">
                  <span className="font-mono">{shortSandboxId(sandbox.id)}</span>
                  <span aria-hidden>·</span>
                  <span>{sandbox.ownerKind === "machine_run" ? "machine run" : "chat"}</span>
                  {sandbox.projectName && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{sandbox.projectName}</span>
                    </>
                  )}
                  <span aria-hidden>·</span>
                  <span className={sandbox.status === "stopped" ? "text-warning" : undefined}>
                    {sandbox.status}
                  </span>
                  <span aria-hidden>·</span>
                  <LocalTime ms={sandbox.lastUsedAt} />
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/sandboxes" className="text-xs text-muted-foreground">
            <Box aria-hidden />
            Manage sandboxes
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The sweatshop chat page: ChatSession in its full-page frame — the
 * AppHeader (crumbs, model and sandbox pickers), `/c/<id>` adoption,
 * ⌘⇧O new chat, and the fresh composer's target picker.
 */
export function ChatSurface({
  conversationId,
  initialMessages,
  activeRunId,
  projectId,
  projectName,
  initialRoute,
  conversationTitle,
  headerExtra,
  initialSkillId,
  projectOptions,
}: {
  conversationId?: string;
  initialMessages?: import("ai").UIMessage[];
  activeRunId?: string | null;
  projectId?: string;
  projectName?: string;
  initialRoute?: ChatRoute | null;
  conversationTitle?: string | null;
  headerExtra?: React.ReactNode;
  /** 0039: preselect this skill (`?skill=`; project scope only). */
  initialSkillId?: string | null;
  /** 0018: pickable chat-in-project targets for the fresh composer
   *  (the ?project= param seeds the initial scope). */
  projectOptions?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sessionRef = useRef<ChatSessionController>(null);

  // 0018: the fresh composer's project scope is PICKABLE on / (the
  // ?project= param seeds it). The prop is the initial value only —
  // ChatSession reads the picked id at send time, so changing it while
  // fresh rebinds the conversation that send creates.
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(projectId ?? null);
  const activeProjectId = pickedProjectId ?? null;
  const activeProjectName = projectOptions?.find((p) => p.id === activeProjectId)?.name ?? projectName;
  // 0021: the picker's catalog, scoped to the project's restrictions.
  const models = useModelsView(activeProjectId);

  // 0015: this page is the chat itself (an adopted conversation) or the
  // project composer (a fresh chat bound to a project). projectId rides
  // along so a panel conversation started here binds to the project.
  usePageContext(
    conversationId
      ? {
          kind: "chat",
          id: conversationId,
          title: conversationTitle ?? undefined,
          ...(activeProjectId ? { projectId: activeProjectId } : {}),
        }
      : activeProjectId
        ? { kind: "project", id: activeProjectId, title: activeProjectName, projectId: activeProjectId }
        : { kind: "other" },
  );

  // ── 0039: the fresh composer's target — a chat, in a project, by a skill ──
  const skills = useSkills();
  const [pickedSkillId, setPickedSkillId] = useState<string | null>(initialSkillId ?? null);
  const activeSkillId = !conversationId && activeProjectId ? pickedSkillId : null;

  /** 0018: pick (or clear) the composer's project scope; the URL
   *  follows so the scope is visible and shareable while fresh. */
  const pickProject = (id: string | null) => {
    setPickedProjectId(id);
    setPickedSkillId(null);
    if (!conversationId) {
      window.history.replaceState(null, "", id ? `/?project=${id}` : "/");
    }
  };

  const freshComposer = (): FreshComposerMode | undefined => {
    if (conversationId) return undefined;
    const book = skills?.find((b) => b.id === activeSkillId) ?? null;
    const footer = (
      <FreshTargetPicker
        projects={projectOptions}
        selectedProjectId={activeProjectId}
        onSelectProject={pickProject}
        skills={skills}
        selectedSkillId={activeSkillId}
        onSelectSkill={setPickedSkillId}
      />
    );
    // The picker shows when there is anything to pick (projects and/or
    // skills); the default composer stands otherwise.
    if (!projectOptions?.length && !book) return undefined;
    return {
      emptyState: book ? (
        <ConversationEmptyState
          icon={<BookOpen className="size-6" />}
          title={book.title}
          description={book.description}
        />
      ) : undefined,
      footer,
    };
  };

  // ── URL behaviour: adopt /c/<id>, new chat (⌘⇧O) ───────────────────────
  // The URL stays on / while the creating turn is live: a refresh (this
  // one, or the attention poll's) re-renders the SAME page segment and the
  // session survives. Swapping to /c/<id> first made every refresh render
  // the /c page instead — a remount that dropped the live stream.
  const handleAdopted = () => {
    router.refresh(); // the sidebar gains the conversation
  };
  const handleAddressable = (id: string) => {
    window.history.replaceState(null, "", `/c/${id}`);
  };

  const handleNewChat = () => {
    if (activeProjectId) {
      window.history.replaceState(null, "", `/?project=${activeProjectId}`);
    } else if (pathname === "/" || window.location.pathname.startsWith("/c/")) {
      window.history.replaceState(null, "", "/");
    } else {
      router.push("/");
      return;
    }
    sessionRef.current?.reset();
    sessionRef.current?.focus();
  };

  const newChatRef = useRef(handleNewChat);
  useEffect(() => {
    newChatRef.current = handleNewChat;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        newChatRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <ChatSession
      ref={sessionRef}
      conversationId={conversationId}
      initialMessages={initialMessages}
      activeRunId={activeRunId}
      projectId={activeProjectId ?? undefined}
      skill={activeSkillId}
      initialRoute={initialRoute}
      className="mx-auto h-full max-w-(--content-max)"
      onAdopted={handleAdopted}
      onAddressable={handleAddressable}
      freshComposer={() => freshComposer()}
      composerTools={(s) => (
        <>
          <RoutePicker
            ariaLabel="Chat model"
            className={COMPOSER_PICKER}
            value={s.route}
            onChange={s.selectRoute}
            view={models}
            inheritLabel={shortRouteLabel(models?.project?.defaultRoute ?? models?.defaults.chat ?? null, models)}
          />
          <SandboxPicker
            className={COMPOSER_PICKER}
            choice={s.sandboxChoice}
            editable={!s.started}
            onSelect={s.setSandboxChoice}
            onOpen={s.loadSandboxes}
            sandboxes={s.sandboxes}
            view={s.sandboxView}
            hasProject={Boolean(activeProjectId)}
          />
        </>
      )}
      header={(s) => (
        <AppHeader
          crumbs={[
            activeProjectId
              ? { label: activeProjectName ?? activeProjectId, href: `/p/${activeProjectId}` }
              : { label: "Chats", href: "/" },
            { label: conversationTitle ?? "New chat" },
          ]}
        >
          {/* 0041: plan → build → PR, derived from the transcript. */}
          <PhaseChip phase={s.phase} variant="header" />
          {/* 0016: previews in this chat's sandbox (any tool in the tree). */}
          <PreviewPill owner={s.started ? s.conversationId : null} />
          {headerExtra}
        </AppHeader>
      )}
    />
  );
}

