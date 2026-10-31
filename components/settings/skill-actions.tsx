"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { InvokeMode } from "@/lib/skills/store";
import { deleteSkillRequest, setSkillDisabledRequest, setSkillInvokeModeRequest, type SkillMutationResult } from "@/lib/api/skills-catalog";

/** 0091 §2: the three invocation modes as segmented-control entries. */
const INVOKE_CHOICES: readonly { mode: InvokeMode; label: string; hint: string }[] = [
  { mode: "auto", label: "Auto", hint: "listed in every chat; the agent loads it on demand" },
  { mode: "tool", label: "Tool", hint: "hidden from chat listings; mounted into harnesses" },
  { mode: "manual", label: "Manual", hint: "only joins when you attach it to a prompt" },
];

/**
 * 0090 §5 / 0091 §2: the curator's actions — the agent stays the author
 * (save_skill, approval-gated); this is the owner disabling, enabling,
 * deleting, or changing the invocation mode directly. Every mutation
 * ends in router.refresh() (delete leaves the page) so the server data
 * is the state.
 */
export function SkillActions({ id, disabled, invoke }: { id: string; disabled: boolean; invoke: InvokeMode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applied = (res: SkillMutationResult | { error: string }, action: string): res is SkillMutationResult => {
    if ("error" in res) {
      setError(res.error);
      return false;
    }
    if (!res.ok) {
      setError(res.message ?? `${action} failed`);
      return false;
    }
    return true;
  };

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await setSkillDisabledRequest(id, !disabled);
      if (applied(res, "update")) router.refresh();
    } catch {
      setError("could not reach the server");
    } finally {
      setBusy(false);
    }
  };

  const setMode = async (mode: InvokeMode) => {
    if (mode === invoke) return;
    setBusy(true);
    setError(null);
    try {
      const res = await setSkillInvokeModeRequest(id, mode);
      if (applied(res, "update")) router.refresh();
    } catch {
      setError("could not reach the server");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await deleteSkillRequest(id);
      if (applied(res, "delete")) router.push("/settings/skills");
    } catch {
      setError("could not reach the server");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex gap-2" role="radiogroup" aria-label="Invocation mode">
        {INVOKE_CHOICES.map(({ mode, label, hint }) => (
          <Button
            key={mode}
            size="sm"
            variant="ghost"
            title={hint}
            aria-checked={invoke === mode}
            role="radio"
            className="h-8 rounded-lg border border-border px-3 text-sm text-muted-foreground data-[on=true]:bg-secondary data-[on=true]:text-secondary-foreground"
            data-on={invoke === mode}
            disabled={busy}
            onClick={() => void setMode(mode)}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggle()}>
          {busy ? "Working…" : disabled ? "Enable" : "Disable"}
        </Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirming(true)}>
          Delete
        </Button>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{id}”?</DialogTitle>
            <DialogDescription>
              Deletes the skill and its files from the store. Object versioning keeps history in the bucket.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy ? "Deleting…" : "Delete skill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
