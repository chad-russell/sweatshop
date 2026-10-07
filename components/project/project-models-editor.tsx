"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RoutePicker, shortRouteLabel } from "@/components/route-picker";
import { LABEL } from "@/components/form-styles";
import type { ModelsView } from "@/lib/providers/catalog-view";
import type { ProviderId } from "@/lib/providers/catalog";
import type { ChatRoute, RouteHarness } from "@/lib/providers/route";

/**
 * 0021 §6: the project page's Models card — the project's default route
 * (chats, agent stages, pi) and the optional allowed-providers /
 * allowed-harnesses lists (none ticked-off = unrestricted). Every change
 * saves immediately through PATCH /api/projects/[id]/models; a combination
 * that would forbid the current default is refused with the reason.
 */
export function ProjectModelsEditor({ projectId, initial }: { projectId: string; initial: ModelsView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const project = view.project!;

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/models`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(json.error ?? `failed (${res.status})`);
      setBusy(false);
      return;
    }
    // Refetch the scoped view so the picker reflects the new restrictions.
    const next = await fetch(`/api/models?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
    if (next.ok) setView((await next.json()) as ModelsView);
    setBusy(false);
    router.refresh();
  };

  const providers = view.providers;
  const toggleProvider = (id: ProviderId) => {
    const current = project.allowedProviders ?? providers.map((p) => p.id);
    const next = current.includes(id) ? current.filter((p) => p !== id) : [...current, id];
    void patch({ allowedProviders: next.length === providers.length ? null : next });
  };
  const harnesses: RouteHarness[] = ["pi", "claude"];
  const toggleHarness = (id: RouteHarness) => {
    const current = project.allowedHarnesses ?? harnesses;
    const next = current.includes(id) ? current.filter((h) => h !== id) : [...current, id];
    void patch({ allowedHarnesses: next.length === harnesses.length ? null : next });
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex min-w-48 flex-1 flex-col">
          <span className="text-sm font-medium">Default model</span>
          <span className={LABEL}>Chats, agent stages, and pi in this project, unless picked per chat or stage.</span>
        </span>
        <RoutePicker
          ariaLabel="Project default model"
          value={project.defaultRoute}
          view={view}
          inheritLabel={shortRouteLabel(view.defaults.chat, view)}
          onChange={(route: ChatRoute | null) => void patch({ defaultRoute: route })}
        />
      </div>

      <fieldset className="flex flex-col gap-1.5" disabled={busy}>
        <legend className={LABEL}>Allowed providers {project.allowedProviders ? "" : "(all)"}</legend>
        <div className="flex flex-wrap gap-4">
          {providers.map((p) => (
            <label key={p.id} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={!project.allowedProviders || project.allowedProviders.includes(p.id)}
                onChange={() => toggleProvider(p.id)}
              />
              {p.label}
              {!p.available && <span className={LABEL}>(no key)</span>}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1.5" disabled={busy}>
        <legend className={LABEL}>Allowed harnesses {project.allowedHarnesses ? "" : "(all)"}</legend>
        <div className="flex flex-wrap gap-4">
          {harnesses.map((h) => (
            <label key={h} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={!project.allowedHarnesses || project.allowedHarnesses.includes(h)}
                onChange={() => toggleHarness(h)}
              />
              {h}
              {h === "claude" && <span className={LABEL}>(subscription)</span>}
            </label>
          ))}
        </div>
      </fieldset>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
