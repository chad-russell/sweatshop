"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LABEL, MONO } from "@/components/form-styles";
import type { ModelsView } from "@/lib/providers/catalog-view";
import type { CodexLoginHandle } from "@/lib/harness-auth/codex-login";

/**
 * 0050 phase 5: the settings Providers row for codex, with the login.
 * "Log in with ChatGPT" runs the CLI's OAuth device flow through
 * /api/x/codex/login/* — the code + verification link render here, the
 * BROWSER polls our poll route on the issuer's cadence (the handle,
 * give-up stamp included, is client-held; the server is stateless), and
 * approval just reloads the models view. "Paste auth.json instead" is
 * the documented fallback for when device login is blocked. No token
 * text is ever rendered — the wire carries status shapes only.
 */

type Phase = "idle" | "starting" | "waiting";

/** Module scope (like loginExpiry below) so the impure clock read stays
 *  out of the component body. */
function handleExpired(h: CodexLoginHandle): boolean {
  return Date.now() >= h.expiresAt;
}

export function CodexLoginRow({
  codex,
  busy,
  onChanged,
}: {
  codex: ModelsView["codex"];
  busy: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [login, setLogin] = useState<{ userCode: string; verificationUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // Never leave a poll scheduled after unmount.
  useEffect(() => () => stopTimer(), []);

  const fail = (message: string) => {
    stopTimer();
    setPhase("idle");
    setLogin(null);
    setError(message);
  };

  const start = async () => {
    setError(null);
    setPasteOpen(false);
    setPhase("starting");
    try {
      const res = await fetch("/api/x/codex/login/start", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        userCode?: string;
        verificationUrl?: string;
        handle?: CodexLoginHandle;
      };
      if (!res.ok || !body.userCode || !body.verificationUrl || !body.handle) {
        fail(body.error ?? `login failed (${res.status})`);
        return;
      }
      setLogin({ userCode: body.userCode, verificationUrl: body.verificationUrl });
      setPhase("waiting");
      schedulePoll(body.handle);
    } catch {
      fail("login failed — could not reach the server");
    }
  };

  /** One issuer poll per browser poll, on the handle's cadence (the
   *  issuer's slow_down widens it server-side and the new handle rides
   *  back in the poll response). */
  const schedulePoll = (h: CodexLoginHandle) => {
    stopTimer();
    timer.current = setTimeout(() => void poll(h), Math.max(1, h.interval) * 1000);
  };

  const poll = async (h: CodexLoginHandle) => {
    if (handleExpired(h)) {
      fail("the login window expired — start the login again");
      return;
    }
    try {
      const res = await fetch("/api/x/codex/login/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: h }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: string;
        handle?: CodexLoginHandle;
      };
      if (res.ok && body.status === "pending" && body.handle) {
        schedulePoll(body.handle);
        return;
      }
      if (res.ok && body.status === "approved") {
        stopTimer();
        setPhase("idle");
        setLogin(null);
        await onChanged();
        return;
      }
      fail(body.error ?? `login failed (${res.status})`);
    } catch {
      fail("login failed — could not reach the server");
    }
  };

  const cancel = () => fail("login cancelled");

  const logout = async () => {
    setError(null);
    try {
      const res = await fetch("/api/x/codex/login", { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `logout failed (${res.status})`);
        return;
      }
      await onChanged();
    } catch {
      setError("logout failed — could not reach the server");
    }
  };

  const paste = async () => {
    setPasteBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/x/codex/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "paste", authJson: pasteText }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `save failed (${res.status})`);
        return;
      }
      setPasteOpen(false);
      setPasteText("");
      await onChanged();
    } catch {
      setError("save failed — could not reach the server");
    } finally {
      setPasteBusy(false);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
      <span className="flex-1 font-medium">codex (subscription)</span>
      {codex.configured ? (
        <>
          <span className={`${MONO} text-muted-foreground`}>
            {loginExpiry(codex.expiresAt) + (codex.accountId ? ` · ${codex.accountId}` : "")}
          </span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void logout()}>
            Log out
          </Button>
        </>
      ) : (
        <>
          {phase !== "waiting" && (
            <Button size="sm" variant="outline" disabled={busy || phase === "starting"} onClick={() => void start()}>
              {phase === "starting" ? "Starting…" : "Log in with ChatGPT"}
            </Button>
          )}
          {!pasteOpen && phase === "idle" && (
            <button
              type="button"
              className="text-muted-foreground underline underline-offset-2"
              onClick={() => setPasteOpen(true)}
            >
              Paste auth.json instead
            </button>
          )}
        </>
      )}
      {!codex.configured && codex.status && phase === "idle" && !pasteOpen && (
        <span className={`${LABEL} w-full`}>{codex.status}</span>
      )}
      {phase === "waiting" && login && (
        <div className="flex w-full flex-col gap-1 rounded-lg border border-border bg-background px-3 py-2.5">
          <span className={LABEL}>Open the link, sign in with your ChatGPT account, and approve this code:</span>
          <span className="w-fit rounded bg-muted px-2 py-1 font-mono text-lg tracking-widest select-all">
            {login.userCode}
          </span>
          <a
            className="text-muted-foreground break-all underline underline-offset-2"
            href={login.verificationUrl}
            target="_blank"
            rel="noreferrer"
          >
            {login.verificationUrl}
          </a>
          <span className="flex items-center gap-3">
            <span className={LABEL}>waiting for approval…</span>
            <button
              type="button"
              className="text-muted-foreground underline underline-offset-2"
              onClick={cancel}
            >
              Cancel
            </button>
          </span>
        </div>
      )}
      {pasteOpen && !codex.configured && (
        <div className="flex w-full flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2.5">
          <label className={LABEL} htmlFor="codex-auth-json">
            The auth.json `codex login` writes (on any machine with a browser) — the documented fallback when device
            login is blocked:
          </label>
          <textarea
            id="codex-auth-json"
            className="min-h-24 w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground"
            spellCheck={false}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder='{"auth_mode":"chatgpt",…}'
          />
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pasteBusy || !pasteText.trim()}
              onClick={() => void paste()}
            >
              Save
            </Button>
            <button
              type="button"
              className="text-muted-foreground underline underline-offset-2"
              onClick={() => {
                setPasteOpen(false);
                setPasteText("");
              }}
            >
              Close
            </button>
          </span>
        </div>
      )}
      {error && (
        <span role="alert" className={`${LABEL} w-full text-destructive`}>
          {error}
        </span>
      )}
    </li>
  );
}

/** "logged in · expires in 41 days" — the access-token expiry, when known. */
function loginExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return "logged in";
  const days = Math.floor((expiresAt - Date.now()) / 86_400_000);
  return days >= 0 ? `logged in · expires in ${days} day${days === 1 ? "" : "s"}` : "logged in";
}
