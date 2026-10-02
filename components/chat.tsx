"use client";

import { Box, Check, ChevronsUpDown, Workflow } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ConversationEmptyState } from "@/components/ai-elements/conversation";
import { AppHeader } from "@/components/app-header";
import {
  ChatSession,
  type ChatSessionController,
  type ChatSessionState,
  type FreshComposerMode,
  type SandboxOption,
} from "@/components/chat-session";
import { usePageContext } from "@/components/page-context";
import { RunTargetPicker, startMachineRun, useScopedMachines } from "@/components/machines/run-target";
import { LocalTime } from "@/components/local-time";
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
import { CHAT_MODELS, findChatModel } from "@/lib/model";
import { cn } from "@/lib/utils";

/**
 * The chat page frame (0010 Phase 4; split in 0015 Phase 3): the
 * AppHeader with the model and sandbox pickers, URL behaviour (adopting
 * `/c/<id>` on first send, ⌘⇧O new chat), and the fresh composer's
 * machine-run target (0012). The transcript, composer and transport
 * live in ChatSession, which this frame and the agent panel share.
 */

/** Model picker — a per-conversation knob, applied on the next send. */
function ModelPicker({
  selectedId,
  onSelect,
  displayLabel,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
  displayLabel: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Chat model"
          title="Model for this conversation"
          className="inline-flex h-8 max-w-40 items-center gap-1 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {CHAT_MODELS.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onSelect={() => onSelect(model.id)}
            className="items-start py-2"
          >
            <Check
              className={cn("mt-0.5", model.id === selectedId ? "opacity-100" : "opacity-0")}
              aria-hidden
            />
            <span className="flex flex-col">
              <span>{model.label}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {model.description}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  "inline-flex h-8 max-w-48 items-center gap-1 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

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
}: {
  choice: string;
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
            className={SANDBOX_TRIGGER}
          >
            <span className="truncate">{label}</span>
            <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
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
          className={SANDBOX_TRIGGER}
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96">
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
 * ⌘⇧O new chat, and the fresh composer's machine-run target.
 */
export function ChatSurface({
  conversationId,
  initialMessages,
  activeRunId,
  projectId,
  projectName,
  initialModelId,
  conversationTitle,
  headerExtra,
  initialMachineId,
}: {
  conversationId?: string;
  initialMessages?: import("ai").UIMessage[];
  activeRunId?: string | null;
  projectId?: string;
  projectName?: string;
  initialModelId?: string | null;
  conversationTitle?: string | null;
  headerExtra?: React.ReactNode;
  /** 0012: preselect this machine as the fresh composer's target. */
  initialMachineId?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sessionRef = useRef<ChatSessionController>(null);

  // 0015: this page is the chat itself (an adopted conversation) or the
  // project composer (a fresh chat bound to a project). projectId rides
  // along so a panel conversation started here binds to the project.
  usePageContext(
    conversationId
      ? {
          kind: "chat",
          id: conversationId,
          title: conversationTitle ?? undefined,
          ...(projectId ? { projectId } : {}),
        }
      : projectId
        ? { kind: "project", id: projectId, title: projectName, projectId }
        : { kind: "other" },
  );

  // ── 0012: a fresh composer can start a machine run instead ────────────
  // Machines load for a not-yet-adopted conversation (the target picker's
  // moment); an adopted one is already a chat.
  const machines = useScopedMachines(conversationId ? undefined : projectId);
  const [pickedMachineId, setPickedMachineId] = useState<string | null>(initialMachineId ?? null);
  const [runStart, setRunStart] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const machineTargeted = machines?.some((m) => m.id === pickedMachineId) ?? false;

  const freshComposer = (s: ChatSessionState): FreshComposerMode | undefined => {
    const machine = machines?.find((m) => m.id === pickedMachineId) ?? null;
    if (!machine) return undefined;
    const startRun = async (text: string) => {
      if (runStart.busy) return;
      setRunStart({ busy: true, error: null });
      try {
        const runId = await startMachineRun({ machineId: machine.id, prompt: text, ...(projectId ? { projectId } : {}) });
        s.clearDraft();
        router.push(`/r/${runId}`);
        router.refresh();
      } catch (err) {
        setRunStart({ busy: false, error: err instanceof Error ? err.message : "failed to start" });
      }
    };
    return {
      emptyState: (
        <ConversationEmptyStateMachine
          title={machine.name}
          description={machine.description ?? "Your message becomes the run's prompt."}
        />
      ),
      placeholder: projectId ? "What should it do? (paste the ticket)" : "What should it work on?",
      footer: (
        <RunTargetPicker
          machines={machines}
          selectedId={machine.id}
          onSelect={(id) => {
            setPickedMachineId(id);
            setRunStart({ busy: false, error: null });
          }}
          projectScoped={Boolean(projectId)}
        />
      ),
      onSubmit: (text) => {
        void startRun(text);
        return true;
      },
      busy: runStart.busy,
      error: runStart.error,
    };
  };

  // ── URL behaviour: adopt /c/<id>, new chat (⌘⇧O) ───────────────────────
  const handleAdopted = (id: string) => {
    window.history.replaceState(null, "", `/c/${id}`);
    router.refresh(); // the sidebar gains the conversation
  };

  const handleNewChat = () => {
    if (projectId) {
      window.history.replaceState(null, "", `/p/${projectId}`);
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
      projectId={projectId}
      initialModelId={initialModelId}
      className="mx-auto h-dvh max-w-3xl"
      onAdopted={handleAdopted}
      freshComposer={freshComposer}
      header={(s) => (
        <AppHeader
          crumbs={[
            projectId
              ? { label: projectName ?? projectId, href: `/p/${projectId}` }
              : { label: "Chats", href: "/" },
            { label: conversationTitle ?? "New chat" },
          ]}
        >
          {/* A machine decides model and sandbox per stage. */}
          {!(s.fresh && machineTargeted) && (
            <>
              <ModelPicker
                selectedId={s.modelId}
                onSelect={s.selectModel}
                displayLabel={findChatModel(s.modelId)?.label ?? s.modelId}
              />
              <SandboxPicker
                choice={s.sandboxChoice}
                editable={!s.started}
                onSelect={s.setSandboxChoice}
                onOpen={s.loadSandboxes}
                sandboxes={s.sandboxes}
                view={s.sandboxView}
                hasProject={Boolean(projectId)}
              />
            </>
          )}
          {headerExtra}
        </AppHeader>
      )}
    />
  );
}

/** The machine-target empty state (kept out of the header closure). */
function ConversationEmptyStateMachine({ title, description }: { title: string; description: string }) {
  return (
    <ConversationEmptyState icon={<Workflow className="size-6" />} title={title} description={description} />
  );
}
