"use client";

import { MonitorX } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { NeedsYouPreview } from "@/lib/read-models/attention";
import { Where } from "./where";

/**
 * 0016: a branch preview the follower parked as failed — one card per
 * failing sha. Fix it starts a chat attached to the preview's sandbox
 * (seeded with the failure); Retry redeploys the remote head; Dismiss
 * hides this sha until the branch fails again at another one.
 */
export function PreviewFailureCard({
  item,
  onAnswered,
}: {
  item: NeedsYouPreview;
  onAnswered: (id: string) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: "retry" | "dismiss") => {
    setBusy(action);
    setError(null);
    const res = await fetch(`/api/previews/${item.previewId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(null);
    if (!res.ok) {
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${action} failed`);
      return;
    }
    onAnswered(item.id);
  };

  const fix = async () => {
    setBusy("fix");
    setError(null);
    const res = await fetch(`/api/previews/${item.previewId}/fix`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    setBusy(null);
    if (!res.ok || !body.url) {
      setError(body.error ?? "could not start a fix chat");
      return;
    }
    router.push(body.url);
  };

  const sha = item.sha && item.sha !== "create" ? item.sha.slice(0, 7) : null;
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-card p-4 text-card-foreground">
      <header className="flex flex-col gap-1">
        <Link href={`/previews?id=${item.previewId}`} className="line-clamp-2 text-sm font-medium hover:underline">
          Preview {item.label} broke{sha ? ` at ${sha}` : " while starting"}
        </Link>
        <Where projectName={item.projectName} path={["Preview", item.branch]} at={item.since} />
      </header>
      <div className="flex items-start gap-2">
        <MonitorX className="mt-0.5 size-4 shrink-0 text-destructive" />
        <pre className="max-h-48 min-w-0 flex-1 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
          {item.error || "no error recorded"}
        </pre>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act("dismiss")}>
          Dismiss
        </Button>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("retry")}>
          {busy === "retry" ? "Retrying…" : "Retry"}
        </Button>
        <Button size="sm" disabled={busy !== null} onClick={() => void fix()}>
          {busy === "fix" ? "Starting…" : "Fix it"}
        </Button>
      </div>
    </article>
  );
}
