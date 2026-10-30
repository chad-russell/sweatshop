import Link from "next/link";
import { BookOpen, Bot, Cpu, Plug, type LucideIcon } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { PageContextRegistration } from "@/components/page-context";
import { db } from "@/db";
import { countStoredDefaults } from "@/db/providers";
import { listTargets } from "@/db/prompt-settings";
import { listGitCredentialViews } from "@/lib/git-hosts/credential-admin";
import { modelsView } from "@/lib/providers/catalog-view";
import { SURFACES } from "@/lib/providers/route";
import { status as skillsStatus } from "@/lib/skills/store";

export const dynamic = "force-dynamic";

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * 0090 §1: settings is a section index — one card per area, each with a
 * cheap server-side status line (0021 §6's content moved verbatim to
 * its own route). Same link-card grade as the projects page.
 */
export default async function SettingsPage() {
  const view = modelsView(db());
  const skills = await skillsStatus();
  const areas: { href: string; icon: LucideIcon; title: string; description: string; status: string }[] = [
    {
      href: "/settings/models",
      icon: Cpu,
      title: "Models",
      description: "Providers, per-surface default routes, and the model catalog.",
      status: `${countStoredDefaults(db())}/${SURFACES.length} defaults set · ${count(
        view.providers.filter((p) => p.available).length,
        "provider",
      )}`,
    },
    {
      href: "/settings/connections",
      icon: Plug,
      title: "Connections",
      description: "Git credentials for sandbox clones, pushes, and PRs.",
      status: count(listGitCredentialViews(db()).length, "git credential"),
    },
    {
      href: "/settings/skills",
      icon: BookOpen,
      title: "Skills",
      description: "Runbooks the agent can load from the skills store.",
      status: skills.configured ? count(skills.skillCount ?? 0, "skill") : "not configured",
    },
    {
      href: "/settings/agent",
      icon: Bot,
      title: "Agent",
      description: "Prompt sections — base instructions and their inclusions.",
      status: count(listTargets(db()).length, "prompt section"),
    },
  ];

  return (
    <div className="mx-auto flex h-full w-full max-w-(--content-max) flex-col overflow-y-auto">
      <PageContextRegistration value={{ kind: "other" }} />
      <AppHeader crumbs={[{ label: "Settings" }]} />
      <div className="p-4 md:p-6">
        <ul className="grid gap-3 sm:grid-cols-2">
          {areas.map((area) => (
            <li key={area.href}>
              <Link
                href={area.href}
                className="flex h-full flex-col gap-1.5 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <area.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  {area.title}
                </span>
                <span className="text-xs text-muted-foreground">{area.description}</span>
                <span className="mt-auto pt-2 font-mono text-xs text-muted-foreground">{area.status}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
