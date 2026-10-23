"use client";

import { Dialog as DialogPrimitive } from "radix-ui";
import { Box, Check, ChevronsUpDown, SlidersHorizontal, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { SandboxOption } from "@/components/chat-session";
import { LocalTime } from "@/components/local-time";
import { RoutePicker, routePickerLabel } from "@/components/route-picker";
import { type ConversationSandboxViewData } from "@/components/sandbox-view";
import {
  Dialog,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import type { ModelsView } from "@/lib/providers/catalog-view";
import type { ChatRoute } from "@/lib/providers/route";
import { shortSandboxId } from "@/lib/sandbox-id";
import { cn } from "@/lib/utils";

/**
 * 0080: below `sm` (and on coarse pointers) the composer footer's model
 * picker, sandbox picker, and host auto-approve toggle collapse into
 * ONE settings chip that opens a bottom sheet — the trio otherwise
 * overflows once a long model name, a bound sandbox, and the work chip
 * all want room on a 390px row. Desktop is unchanged: the same three
 * controls, inline, hidden only on mobile via CSS (not a JS media
 * query, so there is no hydration mismatch) — both subtrees mount, but
 * the sheet's own copies live inside a Radix Dialog, which only renders
 * its content into the DOM while open, so there is never a visible
 * duplicate control, just an invisible (`display: none`) desktop one.
 */

/** In the composer footer the pickers read as quiet text, not boxed buttons. */
export const COMPOSER_PICKER = "min-w-0 shrink border-transparent px-2 max-w-40 sm:max-w-56";

const SANDBOX_TRIGGER =
  "inline-flex h-8 pointer-coarse:h-10 max-w-48 items-center gap-1 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

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

/** 0080: just enough to show the mobile chip's tiny "bound" indicator —
 *  true once a sandbox is actually attached/owned, not merely pending. */
export function hasBoundSandbox(choice: string, editable: boolean, view: ConversationSandboxViewData | null): boolean {
  if (editable) return choice !== "none" && choice !== "auto";
  return view?.state.kind === "own" || view?.state.kind === "attached";
}

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
            title="Where this conversation's bash / harness calls run (fixed for this conversation)"
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
          title="Where this conversation's bash / harness calls will run — chosen once, now"
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
 * 0043 amendment: a per-chat toggle — exec calls run without asking until
 * Chad turns it back off (no time limit; lockout-sensitive commands still
 * ask regardless). Only shown once the conversation exists (the flag
 * lives on its row) and its project has hosts. Updates optimistically,
 * reverting on a failed PATCH.
 */
function HostAutoApproveToggle({
  conversationId,
  initialValue,
  className,
}: {
  conversationId: string;
  initialValue: boolean;
  className?: string;
}) {
  const [checked, setChecked] = useState(initialValue);
  const [pending, setPending] = useState(false);

  const toggle = async (next: boolean) => {
    setChecked(next);
    setPending(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostAutoApprove: next }),
      });
      if (!res.ok) throw new Error("request failed");
    } catch {
      setChecked(!next); // revert — the server never saw it
    } finally {
      setPending(false);
    }
  };

  return (
    <label
      title="Auto-approve host commands: exec calls run without asking, except lockout-sensitive ones — stays on until you turn it off"
      className={cn(
        "inline-flex h-8 pointer-coarse:h-10 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      <Switch
        checked={checked}
        disabled={pending}
        onCheckedChange={(next) => void toggle(next)}
        aria-label="Auto-approve host commands"
      />
      <span className="truncate">Auto-approve hosts</span>
    </label>
  );
}

function SettingsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/**
 * 0080: the composer's model/sandbox/host-approve controls. At `sm` and
 * up, today's three inline chips (pixel-identical — same components,
 * same classes). Below `sm`, one "settings" chip opens a bottom sheet
 * with the same three controls stacked full-width.
 */
export function ComposerSettings({
  route,
  onRouteChange,
  models,
  inheritLabel,
  sandboxChoice,
  sandboxEditable,
  onSandboxSelect,
  onSandboxOpen,
  sandboxes,
  sandboxView,
  hasProject,
  conversationId,
  hasHosts,
  initialHostAutoApprove,
}: {
  route: ChatRoute | null;
  onRouteChange: (route: ChatRoute | null) => void;
  models: ModelsView | null;
  inheritLabel: string;
  sandboxChoice: string;
  sandboxEditable: boolean;
  onSandboxSelect: (choice: string) => void;
  onSandboxOpen: () => void;
  sandboxes: SandboxOption[];
  sandboxView: ConversationSandboxViewData | null;
  hasProject: boolean;
  conversationId?: string;
  hasHosts?: boolean;
  initialHostAutoApprove?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const showHostToggle = Boolean(conversationId && hasHosts);
  const chipLabel = routePickerLabel(route, models, inheritLabel);
  const bound = hasBoundSandbox(sandboxChoice, sandboxEditable, sandboxView);

  return (
    <>
      {/* Desktop (sm+): today's three inline controls, unchanged. */}
      <div className="hidden sm:contents">
        <RoutePicker
          ariaLabel="Chat model"
          className={COMPOSER_PICKER}
          value={route}
          onChange={onRouteChange}
          view={models}
          inheritLabel={inheritLabel}
        />
        <SandboxPicker
          className={COMPOSER_PICKER}
          choice={sandboxChoice}
          editable={sandboxEditable}
          onSelect={onSandboxSelect}
          onOpen={onSandboxOpen}
          sandboxes={sandboxes}
          view={sandboxView}
          hasProject={hasProject}
        />
        {showHostToggle && (
          <HostAutoApproveToggle conversationId={conversationId!} initialValue={initialHostAutoApprove ?? false} className={COMPOSER_PICKER} />
        )}
      </div>

      {/* Mobile (<sm): one chip, one sheet. The sheet's own copies of
          these controls mount only while open (Radix Dialog's default
          behaviour), so there is never a visibly duplicated control —
          only the desktop trio above, hidden (display: none) at rest. */}
      <div className="sm:hidden">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogPrimitive.Trigger asChild>
            <button
              type="button"
              aria-label="Chat settings"
              className="inline-flex h-8 min-w-0 shrink items-center gap-1.5 rounded-lg border border-transparent px-2 pointer-coarse:h-10"
            >
              <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="max-w-36 truncate text-sm text-muted-foreground">{chipLabel}</span>
              {bound && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />}
            </button>
          </DialogPrimitive.Trigger>
          <DialogPortal>
            <DialogOverlay />
            <DialogPrimitive.Content
              className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] w-full flex-col gap-4 overflow-y-auto rounded-t-2xl border-t border-border bg-popover p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-8 data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-bottom-8"
            >
              <div className="flex items-center justify-between">
                <DialogTitle>Chat settings</DialogTitle>
                <DialogPrimitive.Close
                  aria-label="Close"
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-4" aria-hidden />
                </DialogPrimitive.Close>
              </div>
              <DialogDescription className="sr-only">
                This chat&apos;s model, sandbox, and host approval settings.
              </DialogDescription>
              <SettingsRow label="Model">
                <RoutePicker
                  ariaLabel="Chat model"
                  className="w-full max-w-none"
                  value={route}
                  onChange={onRouteChange}
                  view={models}
                  inheritLabel={inheritLabel}
                />
              </SettingsRow>
              <SettingsRow label="Sandbox">
                <SandboxPicker
                  className="w-full max-w-none"
                  choice={sandboxChoice}
                  editable={sandboxEditable}
                  onSelect={onSandboxSelect}
                  onOpen={onSandboxOpen}
                  sandboxes={sandboxes}
                  view={sandboxView}
                  hasProject={hasProject}
                />
              </SettingsRow>
              {showHostToggle && (
                <HostAutoApproveToggle
                  conversationId={conversationId!}
                  initialValue={initialHostAutoApprove ?? false}
                  className="w-full max-w-none justify-between"
                />
              )}
            </DialogPrimitive.Content>
          </DialogPortal>
        </Dialog>
      </div>
    </>
  );
}
