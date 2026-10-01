"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Answer a human gate (0009): one button per allowed target, plus an
 * optional comment that becomes the next stage's "Feedback from Chad".
 * Shared by the run view and the inbox card.
 */
export function GateAnswer({
  runId,
  seq,
  targets,
  onAnswered,
}: {
  runId: string;
  seq: number;
  targets: { to: string; when?: string }[];
  onAnswered?: () => void;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = targets.length > 0 ? targets : [{ to: "end", when: "Done" }];

  const answer = async (to: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/machine-runs/${runId}/visits/${seq}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, ...(comment.trim() ? { comment: comment.trim() } : {}) }),
      });
      if (res.ok) onAnswered?.();
      else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Request failed (${res.status})`);
      }
    } catch {
      setError("Network error — is the server up?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Optional note for the next stage…"
        rows={2}
      />
      <div className="flex flex-wrap gap-2">
        {choices.map((t, i) => (
          <Button
            key={t.to}
            size="sm"
            variant={i === 0 ? "default" : "outline"}
            disabled={busy}
            onClick={() => void answer(t.to)}
            title={`→ ${t.to}`}
          >
            {t.when ?? t.to}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
