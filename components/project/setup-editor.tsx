"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FIELD, LABEL, MONO } from "@/components/form-styles";
import type { ServiceRow, SetupFormValues } from "@/components/project/setup-form";

/**
 * 0017 amendment / 0018: the setup definition's ONE editor — its
 * fields. The form values and conversions are in setup-form.ts. Two
 * hosts: the project page (project-setup-editor.tsx, the definition's
 * permanent home) and the New-preview dialog's first-fill step
 * (components/previews/new-preview.tsx). The definition's shape lives
 * in lib/previews/setup.ts.
 */

const ENV_TEXTAREA =
  `${MONO} w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 outline-none ` +
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

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
        <span className={LABEL}>Default command (a preview can override)</span>
        <Input id={`${ids}-command`} value={values.command} onChange={(e) => set("command", e.target.value)} placeholder="pnpm run dev -H 0.0.0.0 -p $PORT" className={MONO} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className={FIELD} htmlFor={`${ids}-port`}>
          <span className={LABEL}>Default port</span>
          <Input id={`${ids}-port`} value={values.port} onChange={(e) => set("port", e.target.value)} placeholder="3000" inputMode="numeric" className={MONO} />
        </label>
        <label className={FIELD} htmlFor={`${ids}-migrate`}>
          <span className={LABEL}>Migrate — schema, once per sandbox after services are healthy</span>
          <Input id={`${ids}-migrate`} value={values.migrate} onChange={(e) => set("migrate", e.target.value)} placeholder="cd apps/web && pnpm run payload:migrate" className={MONO} />
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
