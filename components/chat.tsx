"use client";

import { BookOpen } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ConversationEmptyState } from "@/components/ai-elements/conversation";
import { AppHeader } from "@/components/app-header";
import {
  ChatSession,
  type ChatSessionController,
  type FreshComposerMode,
} from "@/components/chat-session";
import { usePageContext } from "@/components/page-context";
import { FreshTargetPicker, useSkills } from "@/components/fresh-target-picker";
import { PreviewPill } from "@/components/previews/preview-pill";
import { WorkPill } from "@/components/work-pill";
import { WorkChip } from "@/components/work-chip";
import { ComposerSettings, COMPOSER_PICKER } from "@/components/composer-settings";
import { UsageControl } from "@/components/usage-control";
import { shortRouteLabel, useModelsView } from "@/components/route-picker";
import type { ChatRoute } from "@/lib/providers/route";

/**
 * The chat page frame (0010 Phase 4; split in 0015 Phase 3): the
 * AppHeader with the model and sandbox pickers, URL behaviour (adopting
 * `/c/<id>` on first send, ⌘⇧O new chat), and the fresh composer's
 * skill target (0039). The transcript, composer and transport
 * live in ChatSession, which this frame and the agent panel share.
 */

/**
 * The sweatshop chat page: ChatSession in its full-page frame — the
 * AppHeader (crumbs, model and sandbox pickers), `/c/<id>` adoption,
 * ⌘⇧O new chat, and the fresh composer's target picker.
 */
export function ChatSurface({
  conversationId,
  initialMessages,
  activeRunId,
  activeStreamCursor,
  projectId,
  projectName,
  initialRoute,
  conversationTitle,
  headerExtra,
  initialSkillId,
  projectOptions,
  hasHosts,
  initialHostAutoApprove,
  olderCursor,
  olderRemaining,
}: {
  conversationId?: string;
  initialMessages?: import("ai").UIMessage[];
  activeRunId?: string | null;
  /** 0077: the live run's resume cursor (init-only, like activeRunId). */
  activeStreamCursor?: number | null;
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
  /** 0043 amendment: this project has hosts on its allow-list — shows
   *  the auto-approve toggle once the chat exists. */
  hasHosts?: boolean;
  initialHostAutoApprove?: boolean;
  /** 0075: the tail window's older-page cursor and remaining count —
   *  init-only, straight through to ChatSession's load-earlier control. */
  olderCursor?: number | null;
  olderRemaining?: number;
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
      activeStreamCursor={activeStreamCursor}
      projectId={activeProjectId ?? undefined}
      skill={activeSkillId}
      initialRoute={initialRoute}
      olderCursor={olderCursor}
      olderRemaining={olderRemaining}
      className="mx-auto h-full max-w-(--content-max)"
      onAdopted={handleAdopted}
      onAddressable={handleAddressable}
      freshComposer={() => freshComposer()}
      composerTools={(s) => (
        <>
          <WorkChip
            messages={s.messages}
            className={COMPOSER_PICKER}
          />
          <ComposerSettings
            route={s.route}
            onRouteChange={s.selectRoute}
            models={models}
            inheritLabel={shortRouteLabel(models?.project?.defaultRoute ?? models?.defaults.chat ?? null, models)}
            sandboxChoice={s.sandboxChoice}
            sandboxEditable={!s.started}
            onSandboxSelect={s.setSandboxChoice}
            onSandboxOpen={s.loadSandboxes}
            sandboxes={s.sandboxes}
            sandboxView={s.sandboxView}
            hasProject={Boolean(activeProjectId)}
            conversationId={conversationId}
            hasHosts={hasHosts}
            initialHostAutoApprove={initialHostAutoApprove}
          />
          {/* 0055 PR2: rightmost — the merged context+cost control, hidden until metered. */}
          {conversationId && (
            <UsageControl conversationId={conversationId} busy={s.busy} started={s.started} className="ml-auto" />
          )}
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
          {/* 0078: every PR this thread opened, live state + aggregate diff. */}
          <WorkPill prs={s.workPRs} />
          {/* 0016: previews in this chat's sandbox (any tool in the tree). */}
          <PreviewPill owner={s.started ? s.conversationId : null} />
          {headerExtra}
        </AppHeader>
      )}
    />
  );
}
