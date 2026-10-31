"use client";

import Link from "next/link";
import { useState } from "react";
import { LocalTime } from "@/components/local-time";
import { LABEL, MONO } from "@/components/form-styles";
import type { SkillSummary } from "@/lib/skills/store";

const INPUT = "h-8 w-full rounded-lg border border-border bg-background px-2 text-sm";

/**
 * 0090 §4: the catalog list — a plain client-side filter over id +
 * description (v1; no dialog machinery). Rows carry the trigger text,
 * file count, updated-at and a "disabled" badge; click → detail.
 */
export function SkillsCatalog({ skills }: { skills: SkillSummary[] }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q
    ? skills.filter((s) => s.id.includes(q) || s.description.toLowerCase().includes(q))
    : skills;

  if (skills.length === 0) {
    return (
      <div className="rounded-lg border border-border p-4 text-sm">
        <p>Skills are agent runbooks saved in your skills store.</p>
        <p className="mt-1 text-muted-foreground">
          Ask any chat: <span className={MONO}>&quot;write a skill for …&quot;</span> — you approve every save.
        </p>
      </div>
    );
  }

  return (
    <section aria-labelledby="skills-catalog-title" className="flex flex-col gap-2">
      <h2 id="skills-catalog-title" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Skills
      </h2>
      <input
        aria-label="Filter skills"
        className={INPUT}
        placeholder="Filter by id or description…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className={LABEL}>
        {shown.length} of {skills.length} shown
      </p>
      {shown.length === 0 ? (
        <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          No skills match &quot;{query.trim()}&quot;.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {shown.map((skill) => (
            <li key={skill.id}>
              <Link
                href={`/settings/skills/${skill.id}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5 text-sm hover:bg-muted/50"
              >
                <span className={`${MONO} font-medium`}>{skill.id}</span>
                {skill.disabled && (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    disabled
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{skill.description}</span>
                <span className={LABEL}>
                  {skill.files.length} file{skill.files.length === 1 ? "" : "s"}
                </span>
                <LocalTime className={LABEL} ms={Date.parse(skill.updatedAt)} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
