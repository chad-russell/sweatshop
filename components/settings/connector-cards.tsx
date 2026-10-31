"use client";

import { useState } from "react";
import { Copy, Database, GitBranch, KeyRound, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LABEL, MONO } from "@/components/form-styles";
import { copyText } from "@/lib/clipboard";
import { testConnectorRequest, type ConnectorTestResult } from "@/lib/api/connector-test";
import type { ConnectorRow } from "@/lib/settings/connectors";

const ICON = { provider: KeyRound, harness: Terminal, git: GitBranch, skills: Database } as const;

/**
 * 0090 §2: every account sweatshop authenticates as, one row each.
 * Status is a value shape (never a secret echo); [Test] runs one cheap
 * live check through /api/settings/test and shows the detail inline. A
 * missing credential gets the ONE next action under the row — copyable
 * when it is an env line (T3-style).
 */
export function ConnectorCards({ rows }: { rows: ConnectorRow[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ConnectorTestResult>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const test = async (id: string) => {
    setBusy(id);
    try {
      const res = await testConnectorRequest(id);
      setResults((prev) => ({ ...prev, [id]: "error" in res ? { ok: false, detail: res.error } : res }));
    } catch {
      setResults((prev) => ({ ...prev, [id]: { ok: false, detail: "could not reach the server" } }));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (row: ConnectorRow) => {
    if (row.copy && (await copyText(row.copy))) setCopied(row.id);
  };

  return (
    <section aria-labelledby="connectors-title" className="flex flex-col gap-2">
      <h2 id="connectors-title" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Connectors
      </h2>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {rows.map((row) => {
          const Icon = ICON[row.kind];
          const result = results[row.id];
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex-1 font-medium">{row.label}</span>
              <span
                className={`${MONO} ${
                  row.statusText.includes("error") ? "text-destructive" : row.ok ? "text-success" : "text-muted-foreground"
                }`}
              >
                {row.statusText}
              </span>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void test(row.id)}>
                {busy === row.id ? "Testing…" : "Test"}
              </Button>
              {row.meta && (
                <span className={`${LABEL} flex w-full flex-wrap items-center gap-2`}>
                  {row.meta}
                  {row.copy && (
                    <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs" onClick={() => void copy(row)}>
                      <Copy className="size-3" aria-hidden />
                      {copied === row.id ? "Copied" : "Copy line"}
                    </Button>
                  )}
                </span>
              )}
              {result && (
                <span role="status" className={`${LABEL} w-full ${result.ok ? "text-success" : "text-destructive"}`}>
                  {result.detail}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <span className={LABEL}>The accounts sweatshop authenticates as. Test runs one live check server-side.</span>
    </section>
  );
}
