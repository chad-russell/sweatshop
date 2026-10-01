"use client";

import { Loader2, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "cn";

interface MachineSummary {
  id: string;
  name: string;
  description: string | null;
  definition: { workspace: "project" | "none" };
}

/**
 * Start a machine run (0009). On a project page it offers the project
 * machines (bound to this project); in Chats, the workspace-free ones.
 */
export function StartRunButton({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [machines, setMachines] = useState<MachineSummary[] | null>(null);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wanted = projectId ? "project" : "none";

  useEffect(() => {
    if (!open || machines) return;
    void fetch("/api/machines", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ machines: MachineSummary[] }>)
      .then(({ machines: all }) => {
        const usable = all.filter((m) => m.definition.workspace === wanted);
        setMachines(usable);
        setMachineId((cur) => cur ?? usable[0]?.id ?? null);
      })
      .catch(() => setError("Could not load machines"));
  }, [open, machines, wanted]);

  const start = async () => {
    if (!machineId || !prompt.trim() || starting) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/machine-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineId, prompt, ...(projectId ? { projectId } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as
        | { run?: { id: string }; error?: string; details?: string[] }
        | null;
      if (!res.ok || !body?.run) {
        throw new Error(body?.details?.join("; ") ?? body?.error ?? `start failed (${res.status})`);
      }
      router.push(`/r/${body.run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to start");
      setStarting(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        onClick={() => setOpen(true)}
        title="Run a machine"
        aria-label="Run a machine"
      >
        <Workflow />
      </Button>
      <Dialog open={open} onOpenChange={(next) => !starting && setOpen(next)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Run a machine</DialogTitle>
            <DialogDescription>
              {projectId
                ? "Every coding stage works in one fresh sandbox of this project."
                : "Workspace-free machines: eve conversations and your decisions."}
            </DialogDescription>
          </DialogHeader>

          {machines === null ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : machines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No {projectId ? "project" : "workspace-free"} machines yet —{" "}
              <Link href="/machines" className="underline">create one</Link>.
            </p>
          ) : (
            <div role="radiogroup" aria-label="Machine" className="flex flex-col gap-1.5">
              {machines.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={machineId === m.id}
                  onClick={() => setMachineId(m.id)}
                  className={cn(
                    "rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-accent",
                    machineId === m.id && "border-ring bg-accent",
                  )}
                >
                  <span className="text-sm font-medium">{m.name}</span>
                  {m.description && (
                    <span className="block text-xs text-muted-foreground">{m.description}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={projectId ? "What should it do? (paste the ticket)" : "What should it work on?"}
            rows={6}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void start();
            }}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button disabled={!machineId || !prompt.trim() || starting} onClick={() => void start()}>
              {starting && <Loader2 className="animate-spin" />}
              {starting ? "Starting…" : "Run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
