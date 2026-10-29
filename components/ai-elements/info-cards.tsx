"use client";

import { BanIcon, BookOpenIcon, FolderGit2Icon, LibraryIcon, ServerCogIcon, SquareStackIcon, StickyNoteIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { BashTerminal } from "@/components/ai-elements/bash-terminal";
import { Card, failureLines, statePill } from "@/components/ai-elements/agent-cards";
import { MessageResponse } from "@/components/ai-elements/message";
import { failureOf, type ToolState } from "@/lib/tool-views/inspect";
import {
  cancelView,
  docTopics,
  docsView,
  forgejoView,
  ghView,
  maskEnvValue,
  noteView,
  projectsView,
  runKind,
  setupLabel,
  setupView,
  skillItems,
  skillView,
} from "@/lib/tool-views/info";
import { objectOf } from "@/lib/tool-views/fields";
import { cn } from "@/lib/utils";

/**
 * Designed cards for the read-only "information" tools that used to fall
 * through to the raw JSON viewer: use_skill, system_docs, list_projects,
 * get/save_preview_setup, cancel_run — plus gh and forgejo, which are
 * command-line calls in disguise and render as terminals (like
 * sandbox_exec). Built on the agent-cards shell; the views are pure
 * (lib/tool-views/info.ts) and defensive about stored input/output.
 */

interface CardProps {
  state: ToolState;
  input: unknown;
  output?: unknown;
  errorText?: string;
}

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center truncate rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Markdown in a bounded, scrollable pane — the doc / skill body. */
function Prose({ children }: { children: string }) {
  return (
    <div className="max-h-96 overflow-y-auto px-4 py-3 text-[13px] leading-relaxed">
      <MessageResponse>{children}</MessageResponse>
    </div>
  );
}

const pillFor = (state: ToolState, failed: boolean, done: string) => {
  const sp = statePill(state, failed);
  return { tone: sp.tone, pill: sp.pill === "done" ? done : sp.pill };
};

// --- use_skill -----------------------------------------------------------------

export function SkillCard({ state, input, output, errorText }: CardProps) {
  const failure = failureOf(output);
  const failed = state === "error" || Boolean(failure);
  const view = useMemo(() => skillView(output), [output]);
  const asked = objectOf(input)?.id;
  const options = failure ? skillItems(objectOf(output)?.skills) : view?.kind === "list" ? view.skills : [];
  const loaded = view?.kind === "loaded" ? view : undefined;
  const file = view?.kind === "file" ? view : undefined;
  const subtitle = file ? `${file.id}/${file.file}` : loaded ? loaded.id : typeof asked === "string" ? asked : undefined;
  return (
    <Card
      icon={BookOpenIcon}
      title={file ? "Skill file" : subtitle ? "Skill" : "Skills"}
      subtitle={subtitle ?? (options.length ? `${options.length} available` : "…")}
      {...pillFor(state, failed, loaded || file ? "loaded" : "listed")}
      failed={failed}
      errorLines={failureLines(output, errorText)}
      defaultOpen={options.length > 0 && options.length <= 8}
    >
      {loaded ? (
        <>
          <p className="px-4 pt-2 text-[12.5px] font-medium">{loaded.title}</p>
          <Prose>{loaded.body}</Prose>
        </>
      ) : file ? (
        <Prose>{file.content}</Prose>
      ) : options.length > 0 ? (
        <ul className="divide-y divide-border">
          {options.map((s) => (
            <li key={s.id} className="flex items-baseline gap-2.5 px-3 py-1.5">
              <span className="shrink-0 font-mono text-[12px] font-medium">{s.id}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground" title={s.description}>
                {s.description}
              </span>
            </li>
          ))}
        </ul>
      ) : undefined}
    </Card>
  );
}

// --- system_docs ---------------------------------------------------------------

export function DocsCard({ state, input, output, errorText }: CardProps) {
  const failure = failureOf(output);
  const failed = state === "error" || Boolean(failure);
  const view = useMemo(() => docsView(output), [output]);
  const asked = objectOf(input)?.topic;
  const topics = failure ? docTopics(objectOf(output)?.topics) : view?.kind === "list" ? view.topics : [];
  const doc = view?.kind === "doc" ? view : undefined;
  return (
    <Card
      icon={LibraryIcon}
      title={doc || typeof asked === "string" ? "Read doc" : "Docs"}
      subtitle={doc ? doc.title : typeof asked === "string" ? asked : topics.length ? `${topics.length} topics` : "…"}
      extra={doc ? <Chip className="hidden sm:inline-flex">docs/agent/{doc.topic}.md</Chip> : undefined}
      {...pillFor(state, failed, doc ? `${doc.doc.split("\n").length} lines` : "listed")}
      failed={failed}
      errorLines={failureLines(output, errorText)}
      defaultOpen={!doc && topics.length > 0 && topics.length <= 8}
    >
      {doc ? (
        <Prose>{doc.doc}</Prose>
      ) : topics.length > 0 ? (
        <ul className="divide-y divide-border">
          {topics.map((t) => (
            <li key={t.topic} className="flex items-baseline gap-2.5 px-3 py-1.5">
              <span className="shrink-0 font-mono text-[12px] font-medium">{t.topic}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{t.title}</span>
            </li>
          ))}
        </ul>
      ) : undefined}
    </Card>
  );
}

// --- list_projects -------------------------------------------------------------

export function ProjectsCard({ state, output, errorText }: CardProps) {
  const failed = state === "error" || Boolean(failureOf(output));
  const projects = useMemo(() => projectsView(output), [output]);
  return (
    <Card
      icon={FolderGit2Icon}
      title="Projects"
      subtitle={projects ? `${projects.length} ${projects.length === 1 ? "project" : "projects"}` : "…"}
      {...pillFor(state, failed, "listed")}
      failed={failed}
      errorLines={failureLines(output, errorText)}
      defaultOpen={Boolean(projects && projects.length > 0 && projects.length <= 6)}
    >
      {projects && projects.length > 0 ? (
        <ul className="divide-y divide-border">
          {projects.map((p) => (
            <li key={p.id} className="space-y-1 px-3 py-2">
              <div className="flex min-w-0 items-baseline gap-2">
                <Link
                  href={`/p/${p.id}`}
                  className="min-w-0 truncate text-[12.5px] font-medium underline decoration-border underline-offset-2 hover:decoration-foreground"
                >
                  {p.name}
                </Link>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{p.id}</span>
              </div>
              {p.description && <p className="line-clamp-2 text-xs text-muted-foreground">{p.description}</p>}
              <div className="flex flex-wrap gap-1.5">
                {p.repos.map((r) => (
                  <Chip key={r.name} className="max-w-64">
                    <span title={r.url}>{r.name}</span>
                  </Chip>
                ))}
                {p.testCommand && <Chip>test: {p.testCommand}</Chip>}
                {p.branchPrefix && <Chip>branch: {p.branchPrefix}/</Chip>}
              </div>
            </li>
          ))}
        </ul>
      ) : projects ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No projects yet.</p>
      ) : undefined}
    </Card>
  );
}

// --- get_preview_setup / save_preview_setup ------------------------------------

export function PreviewSetupCard({ tool, state, output, errorText }: CardProps & { tool: "get_preview_setup" | "save_preview_setup" }) {
  const failed = state === "error" || Boolean(failureOf(output));
  const setup = useMemo(() => setupView(output), [output]);
  const saving = tool === "save_preview_setup";
  const none = setup === null;
  const steps: [string, string | undefined][] = setup
    ? [
        ["install", setup.install],
        ["migrate", setup.migrate],
        ["seed", setup.seed],
        ["start", setup.command],
      ]
    : [];
  return (
    <Card
      icon={ServerCogIcon}
      title={saving ? (state === "running" ? "Saving preview setup" : "Saved preview setup") : "Preview setup"}
      subtitle={none ? "none saved yet" : setup ? setupLabel(setup) : "…"}
      {...pillFor(state, failed, saving ? "saved" : none ? "empty" : "loaded")}
      failed={failed}
      errorLines={failureLines(output, errorText)}
      defaultOpen={saving && Boolean(setup)}
    >
      {setup ? (
        <div className="space-y-2.5 px-3 py-2.5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[12px]">
            {steps.map(([label, cmd]) =>
              cmd ? (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 break-words">{cmd}</dd>
                </div>
              ) : null,
            )}
          </dl>
          {setup.services.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {setup.services.map((s) => (
                <Chip key={s.name} className="gap-1">
                  <SquareStackIcon className="size-3" aria-hidden />
                  {s.name} · {s.image} · :{s.port}
                </Chip>
              ))}
            </div>
          )}
          {setup.env.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {setup.env.map(([k, v]) => (
                <Chip key={k}>
                  {k}={maskEnvValue(k, v)}
                </Chip>
              ))}
            </div>
          )}
        </div>
      ) : undefined}
    </Card>
  );
}

// --- gh / forgejo (terminal) ---------------------------------------------------

/** A read-only gh / forgejo call: the command as typed, the output below it. */
export function QueryTerminal({ tool, state, input, output, errorText }: CardProps & { tool: "gh" | "forgejo" }) {
  const view = tool === "gh" ? ghView(input, output) : forgejoView(input, output);
  const failure = failureOf(output);
  const ok = objectOf(output)?.ok === true;
  return (
    <BashTerminal
      className="my-1"
      state={state === "running" ? "input-available" : state === "error" ? "output-error" : "output-available"}
      input={{ command: view.command }}
      output={ok ? { exitCode: 0, stdout: view.output, stderr: "" } : failure ? { exitCode: 1, stdout: "", stderr: failure.message } : undefined}
      errorText={errorText}
      extra={<span className="px-1 font-mono text-[10px] text-terminal-muted">{tool === "gh" ? "github" : "forgejo"}</span>}
    />
  );
}

// --- note ----------------------------------------------------------------------

/** The agent talking to itself: a quiet tinted aside with the note as readable text — no JSON, no echoed result. */
export function NoteCard({ state, input, output, errorText }: CardProps) {
  const failed = state === "error";
  const text = noteView(input, output);
  return (
    <div
      className={cn(
        "not-prose my-1 flex items-start gap-2.5 rounded-lg border border-l-2 px-3 py-2 text-card-foreground",
        failed ? "border-destructive/40 border-l-destructive bg-destructive/5" : "border-border border-l-info bg-muted/40",
      )}
    >
      <StickyNoteIcon className={cn("mt-0.5 size-4 shrink-0", failed ? "text-destructive" : "text-muted-foreground")} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {failed ? "Note failed" : state === "running" ? "Noting…" : "Note to self"}
        </p>
        {failed ? (
          <p className="mt-0.5 font-mono text-[11px] text-destructive">{failureLines(output, errorText)?.[0]}</p>
        ) : text ? (
          <MessageResponse className="mt-0.5 break-words text-[13px] leading-relaxed">{text}</MessageResponse>
        ) : null}
      </div>
    </div>
  );
}

// --- cancel_run ----------------------------------------------------------------

/** One quiet line, like a hand-off: what was cancelled. */
export function CancelRunCard({ state, input, output, errorText }: CardProps) {
  const failed = state === "error" || Boolean(failureOf(output));
  const { id, note } = cancelView(input, output);
  return (
    <div
      className={cn(
        "not-prose my-1 flex items-start gap-2.5 rounded-lg border px-3 py-2 text-card-foreground",
        failed ? "border-destructive/40 bg-destructive/5" : "border-border bg-card",
      )}
    >
      <BanIcon className={cn("mt-0.5 size-4 shrink-0", failed ? "text-destructive" : "text-muted-foreground")} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px]">
          <span className="text-muted-foreground">
            {failed ? "Couldn't cancel" : state === "running" ? "Cancelling" : "Cancelled"} {runKind(id)}
          </span>{" "}
          <span className="font-mono font-medium">{id}</span>
        </p>
        {failed ? (
          <p className="mt-0.5 font-mono text-[11px] text-destructive">{failureLines(output, errorText)?.[0]}</p>
        ) : note ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{note}</p>
        ) : null}
      </div>
    </div>
  );
}
