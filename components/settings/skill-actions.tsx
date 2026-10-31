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
import { deleteSkillRequest, setSkillDisabledRequest, type SkillMutationResult } from "@/lib/api/skills-catalog";

/**
 * 0090 §5: the curator's actions — the agent stays the author
 * (save_skill, approval-gated); this is the owner disabling, enabling or
 * deleting directly. Both mutations end in router.refresh() (delete
 * leaves the page) so the server data is the state.
 */
export function SkillActions({ id, disabled }: { id: string; disabled: boolean }) {
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
