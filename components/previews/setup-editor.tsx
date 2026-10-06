"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FIELD, LABEL, MONO } from "@/components/form-styles";
import { parseEnvBlock } from "@/lib/previews/env";
import type { PreviewSetupDefinition } from "@/lib/previews/setup";

/**
 * 0017 amendment / 0018: the setup definition's ONE editor — the fields
 * and the two form↔definition conversions. Two hosts: the project page
 * (project-setup-editor.tsx, the definition's permanent home) and the
 * New-preview dialog (new-preview.tsx, the first-fill moment, which
 * saves the setup as part of the launch). The definition's shape lives
 * in lib/previews/setup.ts.
 */

export interface ServiceRow {
  name: string;
  image: string;
  port: string;
  command: string;
  envText: string;
}

export interface SetupFormValues {
  workDir: string;
  install: string;
  provision: string;
  seed: string;
  command: string;
  port: string;
  envText: string;
  services: ServiceRow[];
}

const ENV_TEXTAREA =
  `${MONO} w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 outline-none ` +
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export const emptySetupForm: SetupFormValues = {
  workDir: "",
  install: "",
  provision: "",
  seed: "",
  command: "",
  port: "",
  envText: "",
  services: [],
};

const envToText = (env: Record<string, string> | undefined): string =>
  Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v.includes(" ") ? JSON.stringify(v) : v}`)
    .join("\n");

export function setupFormFromDefinition(d: PreviewSetupDefinition): SetupFormValues {
  return {
    workDir: d.workDir,
    install: d.install,
    provision: d.provision ?? "",
    seed: d.seed ?? "",
    command: d.command,
    port: String(d.port),
    envText: envToText(d.env),
    services: d.services.map((s) => ({
      name: s.name,
      image: s.image,
      port: String(s.port),
      command: s.command ?? "",
      envText: envToText(s.env),
    })),
  };
}

/** The form's values as a definition (repo injected by the host); a
 * bad env block or service shape is an error string for the host to
 * show. The store's zod remains the authority — this only unwraps the
 * textarea conventions. */
export function definitionFromSetupForm(
  v: SetupFormValues,
  repo: string,
): { definition: PreviewSetupDefinition } | { error: string } {
  const env = parseEnvBlock(v.envText);
  if ("error" in env) return { error: env.error };
  const services: PreviewSetupDefinition["services"] = [];
  for (const [i, s] of v.services.entries()) {
    if (!s.name.trim() || !s.image.trim()) {
      return { error: `service ${i + 1}: name and image are required` };
    }
    const port = Number(s.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { error: `service ${s.name}: port must be 1–65535` };
    }
    const senv = parseEnvBlock(s.envText);
    if ("error" in senv) return { error: `service ${s.name}: ${senv.error}` };
    services.push({
      name: s.name.trim(),
      image: s.image.trim(),
      port,
      ...(s.command.trim() ? { command: s.command.trim() } : {}),
      env: senv.env ?? {},
    });
  }
  return {
    definition: {
      repo,
      workDir: v.workDir.trim() || ".",
      install: v.install,
      ...(v.provision.trim() ? { provision: v.provision.trim() } : {}),
      ...(v.seed.trim() ? { seed: v.seed.trim() } : {}),
      command: v.command,
      port: Number(v.port),
      env: env.env ?? {},
      services,
    },
  };
}

/** The definition's editable fields (everything but repo + label). */
export function SetupFields({
  values,
  onChange,
  ids,
}: {
  values: SetupFormValues;
  onChange: (next: SetupFormValues) => void;
  ids: string;
}) {
  const set = <K extends keyof SetupFormValues>(key: K, value: SetupFormValues[K]) =>
    onChange({ ...values, [key]: value });
  const setService = (i: number, patch: Partial<ServiceRow>) =>
    onChange({ ...values, services: values.services.map((s, j) => (i === j ? { ...s, ...patch } : s)) });

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <label className={FIELD} htmlFor={`${ids}-workdir`}>
          <span className={LABEL}>Directory in repo</span>
          <Input id={`${ids}-workdir`} value={values.workDir} onChange={(e) => set("workDir", e.target.value)} placeholder="apps/web" className={MONO} />
        </label>
        <label className={FIELD} htmlFor={`${ids}-install`}>
          <span className={LABEL}>Install (runs at repo root)</span>
          <Input id={`${ids}-install`} value={values.install} onChange={(e) => set("install", e.target.value)} placeholder="pnpm install" className={MONO} />
        </label>
      </div>
      <label className={FIELD} htmlFor={`${ids}-command`}>
        <span className={LABEL}>Command</span>
        <Input id={`${ids}-command`} value={values.command} onChange={(e) => set("command", e.target.value)} placeholder="pnpm run dev -H 0.0.0.0 -p $PORT" className={MONO} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className={FIELD} htmlFor={`${ids}-port`}>
          <span className={LABEL}>Port</span>
          <Input id={`${ids}-port`} value={values.port} onChange={(e) => set("port", e.target.value)} placeholder="3000" inputMode="numeric" className={MONO} />
        </label>
        <label className={FIELD} htmlFor={`${ids}-provision`}>
          <span className={LABEL}>Provision — migrations, once per sandbox</span>
          <Input id={`${ids}-provision`} value={values.provision} onChange={(e) => set("provision", e.target.value)} placeholder="cd apps/web && pnpm run payload:migrate" className={MONO} />
        </label>
      </div>
      <label className={FIELD} htmlFor={`${ids}-seed`}>
        <span className={LABEL}>Seed — data, once per sandbox (idempotent)</span>
        <Input id={`${ids}-seed`} value={values.seed} onChange={(e) => set("seed", e.target.value)} placeholder="cd apps/web && pnpm run seed" className={MONO} />
      </label>
      <label className={FIELD} htmlFor={`${ids}-env`}>
        <span className={LABEL}>Env — KEY=VALUE lines (may use $&#123;PREVIEW_URL&#125;, $&#123;service:db:5432&#125;)</span>
        <textarea
          id={`${ids}-env`}
          value={values.envText}
          onChange={(e) => set("envText", e.target.value)}
          rows={Math.min(8, Math.max(2, values.envText.split("\n").length))}
          placeholder={"PAYLOAD_SECRET=…\nNEXT_PUBLIC_SERVER_URL=${PREVIEW_URL}"}
          className={ENV_TEXTAREA}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <div className="flex flex-col gap-2">
        <span className={LABEL}>Services — sibling containers (db, s3…), addressed as $&#123;service:name:port&#125;</span>
        {values.services.map((s, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-md border border-input p-2.5">
            <div className="grid grid-cols-[1fr_2fr_5rem_auto] items-end gap-2">
              <label className={FIELD}>
                <span className={LABEL}>Name</span>
                <Input value={s.name} onChange={(e) => setService(i, { name: e.target.value })} placeholder="db" className={MONO} />
              </label>
              <label className={FIELD}>
                <span className={LABEL}>Image</span>
                <Input value={s.image} onChange={(e) => setService(i, { image: e.target.value })} placeholder="docker.io/library/postgres:18-alpine" className={MONO} />
              </label>
              <label className={FIELD}>
                <span className={LABEL}>Port</span>
                <Input value={s.port} onChange={(e) => setService(i, { port: e.target.value })} inputMode="numeric" className={MONO} />
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={() => onChange({ ...values, services: values.services.filter((_, j) => j !== i) })}
              >
                Remove
              </Button>
            </div>
            <label className={FIELD}>
              <span className={LABEL}>Command (entrypoint argv, optional)</span>
              <Input value={s.command} onChange={(e) => setService(i, { command: e.target.value })} placeholder="server /data --console-address :9001" className={MONO} />
            </label>
            <label className={FIELD}>
              <span className={LABEL}>Env</span>
              <textarea
                value={s.envText}
                onChange={(e) => setService(i, { envText: e.target.value })}
                rows={Math.min(4, Math.max(1, s.envText.split("\n").length))}
                placeholder={"POSTGRES_PASSWORD=postgres"}
                className={ENV_TEXTAREA}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() =>
            onChange({
              ...values,
              services: [...values.services, { name: "", image: "", port: "", command: "", envText: "" }],
            })
          }
        >
          Add service
        </Button>
      </div>
    </div>
  );
}
