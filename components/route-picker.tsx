"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ModelsView } from "@/lib/providers/catalog-view";
import { PROVIDER_LABELS } from "@/lib/providers/catalog";
import type { ChatRoute } from "@/lib/providers/route";
import { cn } from "@/lib/utils";

/**
 * 0021: the provider-routed model picker — chats, /settings defaults,
 * project default. Grouped by provider (unavailable and disallowed ones
 * hidden), searchable (OpenRouter lists hundreds). `value` null = the
 * inherited default, shown as "Default (…)" when `inheritLabel` is set.
 */

/** Fetch the models view once per (mount, project). */
export function useModelsView(projectId?: string | null): ModelsView | null {
  const [view, setView] = useState<ModelsView | null>(null);
  useEffect(() => {
    let cancelled = false;
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    fetch(`/api/models${qs}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: ModelsView | null) => {
        if (!cancelled && body) setView(body);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return view;
}

export function shortRouteLabel(route: ChatRoute | null, view: ModelsView | null): string {
  if (!route) return "Default";
  const provider = view?.providers.find((p) => p.id === route.provider);
  const model = provider?.models.find((m) => m.id === route.model);
  const thinking = route.thinking ? ` · ${route.thinking}` : "";
  return `${PROVIDER_LABELS[route.provider].split(" ")[0]} · ${model?.label ?? route.model}${thinking}`;
}

/** 0080: the trigger text `RoutePicker` shows — factored out so the
 *  mobile settings chip can show the same label without a second copy
 *  of the picker mounted. */
export function routePickerLabel(value: ChatRoute | null, view: ModelsView | null, inheritLabel?: string): string {
  if (value) return shortRouteLabel(value, view);
  return inheritLabel ? `Default · ${inheritLabel}` : "Pick a model";
}

const sameRoute = (a: ChatRoute | null, b: ChatRoute | null) =>
  a?.provider === b?.provider && a?.model === b?.model;

export function RoutePicker({
  value,
  onChange,
  view,
  inheritLabel,
  ariaLabel = "Model",
  className,
}: {
  value: ChatRoute | null;
  onChange: (route: ChatRoute | null) => void;
  view: ModelsView | null;
  /** Offer "Default (<label>)" (value null); omit to require a pick. */
  inheritLabel?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const providers = (view?.providers ?? []).filter((p) => p.available && p.allowed);
  const label = routePickerLabel(value, view, inheritLabel);
  // 0021 amendment: the thinking control appears only for models whose
  // catalog entry declares a reasoning knob.
  const modelInfo = value
    ? view?.providers.find((p) => p.id === value.provider)?.models.find((m) => m.id === value.model)
    : undefined;
  const canThink = !!(value && modelInfo?.reasoning);

  return (
    <span className="inline-flex min-w-0 shrink items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            title={value ? `${PROVIDER_LABELS[value.provider]} · ${value.model}` : label}
            className={cn(
              "inline-flex h-8 pointer-coarse:h-10 max-w-56 items-center gap-1 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              className,
            )}
          >
            <span className="truncate">{label}</span>
            <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
          </button>
        </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-1rem)] p-0">
        <Command>
          <CommandInput placeholder="Search models…" />
          <CommandList className="max-h-80">
            <CommandEmpty>{view ? "No models match." : "Loading…"}</CommandEmpty>
            {inheritLabel && (
              <CommandGroup>
                <CommandItem
                  value="__default"
                  keywords={["default", inheritLabel]}
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  <Check className={cn(value === null ? "opacity-100" : "opacity-0")} aria-hidden />
                  <span className="truncate">Default · {inheritLabel}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {providers.map((provider) => (
              <CommandGroup key={provider.id} heading={provider.label}>
                {provider.models.map((model) => {
                  const route: ChatRoute = { provider: provider.id, model: model.id };
                  return (
                    <CommandItem
                      key={model.id}
                      value={`${provider.id}:${model.id}`}
                      keywords={[model.label, model.id, provider.label]}
                      onSelect={() => {
                        onChange(route);
                        setOpen(false);
                      }}
                    >
                      <Check className={cn(sameRoute(value, route) ? "opacity-100" : "opacity-0")} aria-hidden />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{model.label}</span>
                        {model.label !== model.id && (
                          <span className="truncate text-xs text-muted-foreground">{model.id}</span>
                        )}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
      </Popover>
      {canThink && value && (
        <select
          aria-label="Thinking"
          title="Thinking level (unset = the model's default)"
          value={value.thinking ?? ""}
          onChange={(event) => {
            const thinking = event.target.value;
            onChange({ provider: value.provider, model: value.model, ...(thinking ? { thinking: thinking as ChatRoute["thinking"] } : {}) });
          }}
          className="inline-flex h-8 pointer-coarse:h-10 items-center rounded-lg border border-border bg-transparent px-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <option value="">auto</option>
          <option value="off">off</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      )}
    </span>
  );
}
