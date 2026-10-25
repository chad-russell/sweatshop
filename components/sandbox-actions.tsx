"use client";

import { Power, Sparkles, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { reapSandboxes, sandboxAction, type ReapAction } from "@/lib/api/sandboxes";

/**
 * 0013: manual sandbox lifecycle. Stop idles a live sandbox (state kept —
 * the next tool call resumes it); Destroy removes it for good, after a
 * confirm that names what it strands (bound chats/runs keep their
 * binding and must start fresh). Busy sandboxes are refused server-side.
 */
export function SandboxActions({
  sandboxId,
  status,
  bound,
}: {
  sandboxId: string;
  status: string;
  bound: { conversations: number; runs: number };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"stop" | "destroy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (status === "destroyed" || status === "creating") return null;

  const act = async (action: "stop" | "destroy") => {
    setBusy(action);
    setError(null);
    try {
      const failure = await sandboxAction(sandboxId, action);
      if (failure !== null) {
        setError(failure);
        return;
      }
      setConfirming(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const stranded = [
    bound.conversations > 0 && `${bound.conversations} chat${bound.conversations === 1 ? "" : "s"}`,
    bound.runs > 0 && `${bound.runs} run${bound.runs === 1 ? "" : "s"}`,
  ].filter(Boolean);

  return (
    <div className="flex items-center gap-2">
      {error && <span className="max-w-64 truncate text-xs text-destructive" title={error}>{error}</span>}
      {status === "running" && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void act("stop")}
          title="Stop now — files are kept; the next tool call resumes it"
        >
          <Power aria-hidden />
          {busy === "stop" ? "Stopping…" : "Stop"}
        </Button>
      )}
      <Button variant="destructive" size="sm" disabled={busy !== null} onClick={() => setConfirming(true)}>
        <Trash2 aria-hidden />
        Destroy
      </Button>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Destroy this sandbox?</DialogTitle>
            <DialogDescription>
              Its files and processes are gone for good; its history stays on this page.
              {stranded.length > 0 &&
                ` ${stranded.join(" and ")} bound to it will need a new chat to get a sandbox again.`}
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" disabled={busy !== null} onClick={() => void act("destroy")}>
              {busy === "destroy" ? "Destroying…" : "Destroy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 0013: run the reaper now (the same pass the in-app timer runs). */
export function RunCleanupButton() {
  const router = useRouter();
  const [state, setState] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });

  const run = async () => {
    setState({ busy: true, note: null });
    try {
      const res = await reapSandboxes();
      if (!res.ok) {
        setState({ busy: false, note: `cleanup failed (${res.status})` });
        return;
      }
      const report = res.report;
      const count = (a: ReapAction["action"]) => report.actions.filter((x) => x.action === a).length;
      const parts = [
        count("stop") && `stopped ${count("stop")}`,
        count("destroy") && `destroyed ${count("destroy")}`,
        count("skip-busy") && `${count("skip-busy")} busy`,
        report.errors.length && `${report.errors.length} failed`,
      ].filter(Boolean);
      setState({ busy: false, note: parts.length ? parts.join(", ") : "nothing to clean up" });
      router.refresh();
    } catch {
      setState({ busy: false, note: "cleanup failed" });
    }
  };

  return (
    <div className="flex items-center gap-2">
      {state.note && <span className="text-xs text-muted-foreground">{state.note}</span>}
      <Button
        variant="outline"
        size="sm"
        disabled={state.busy}
        onClick={() => void run()}
        title="Stop idle sandboxes and destroy long-idle ones now (chats: 30 min / 14 days; runs: 10 min / 3 days)"
      >
        <Sparkles aria-hidden />
        {state.busy ? "Cleaning up…" : "Run cleanup now"}
      </Button>
    </div>
  );
}
