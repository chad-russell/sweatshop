"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LABEL, MONO } from "@/components/form-styles";
import type { ModelsView } from "@/lib/providers/catalog-view";
import {
  codexBrowserComplete,
  codexBrowserStart,
  codexDeviceStart,
  codexLoginPoll,
  codexLogout,
  codexPasteAuth,
} from "@/lib/api/codex";
import type { CodexBrowserHandle, CodexLoginHandle } from "@/lib/harness-auth/codex-login";

/**
 * 0050 phases 5/5b: the settings Providers row for codex, with the
 * login. The PRIMARY flow is the browser OAuth one ("Log in with
 * ChatGPT" → authorize URL → the user pastes the localhost redirect
 * back) — enterprise workspaces commonly BLOCK device-code auth
 * (Chad's does — 2026-10-18 live), so browser-flow-first is
 * deliberate. "Use a device code instead" keeps the CLI's device flow
 * (code + link, polled here on the issuer's cadence), and "Paste
 * auth.json instead" is the headless fallback. No token text is ever
 * rendered — the wire carries status shapes only.
 */

type Panel = "none" | "browser" | "device" | "paste";
type DevicePhase = "idle" | "starting" | "waiting";

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
  const [panel, setPanel] = useState<Panel>("none");
  const [error, setError] = useState<string | null>(null);

  // Browser flow (5b, primary): the authorize URL + the pasted callback.
  const [browserStarting, setBrowserStarting] = useState(false);
  const [browser, setBrowser] = useState<{ authorizeUrl: string; handle: CodexBrowserHandle } | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [completing, setCompleting] = useState(false);
  const [copied, setCopied] = useState(false);

  // Device flow (5, kept as a disclosure).
  const [devicePhase, setDevicePhase] = useState<DevicePhase>("idle");
  const [deviceLogin, setDeviceLogin] = useState<{ userCode: string; verificationUrl: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // Never leave a poll scheduled after unmount.
  useEffect(() => () => stopTimer(), []);

  const closePanel = () => {
    stopTimer();
    setPanel("none");
    setBrowser(null);
    setCallbackUrl("");
    setDeviceLogin(null);
    setDevicePhase("idle");
    setError(null);
  };

  const startBrowser = async () => {
    setError(null);
    setBrowserStarting(true);
    try {
      const res = await codexBrowserStart();
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setBrowser({ authorizeUrl: res.authorizeUrl, handle: res.handle });
      setPanel("browser");
    } catch {
      setError("login failed — could not reach the server");
    } finally {
      setBrowserStarting(false);
    }
  };

  const completeBrowser = async () => {
    if (!browser) return;
    setCompleting(true);
    setError(null);
    try {
      const failure = await codexBrowserComplete(browser.handle, callbackUrl);
      if (failure !== null) {
        setError(failure);
        return;
      }
      closePanel();
      await onChanged();
    } catch {
      setError("login failed — could not reach the server");
    } finally {
      setCompleting(false);
    }
  };

  const copyAuthorizeUrl = async () => {
    if (!browser) return;
    try {
      await navigator.clipboard.writeText(browser.authorizeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("could not copy — select the link text instead");
    }
  };

  /** One issuer poll per browser poll, on the handle's cadence (the
   *  issuer's slow_down widens it server-side and the new handle rides
   *  back in the poll response). */
  const schedulePoll = (h: CodexLoginHandle) => {
    stopTimer();
    timer.current = setTimeout(() => void pollDevice(h), Math.max(1, h.interval) * 1000);
  };

  const pollDevice = async (h: CodexLoginHandle) => {
    if (handleExpired(h)) {
      setError("the login window expired — start the login again");
      setDevicePhase("idle");
      setDeviceLogin(null);
      return;
    }
    try {
      const res = await codexLoginPoll(h);
      if ("error" in res) {
        setError(res.error);
        setDevicePhase("idle");
        setDeviceLogin(null);
        return;
      }
      if (res.status === "pending") {
        schedulePoll(res.handle);
        return;
      }
      stopTimer();
      closePanel();
      await onChanged();
    } catch {
      setError("login failed — could not reach the server");
      setDevicePhase("idle");
      setDeviceLogin(null);
    }
  };

  const startDevice = async () => {
    setError(null);
    setDevicePhase("starting");
    try {
      const res = await codexDeviceStart();
      if ("error" in res) {
        setError(res.error);
        setDevicePhase("idle");
        return;
      }
      setDeviceLogin({ userCode: res.userCode, verificationUrl: res.verificationUrl });
      setDevicePhase("waiting");
      schedulePoll(res.handle);
    } catch {
      setError("login failed — could not reach the server");
      setDevicePhase("idle");
    }
  };

  const logout = async () => {
    setError(null);
    try {
      const failure = await codexLogout();
      if (failure !== null) {
        setError(failure);
        return;
      }
      await onChanged();
    } catch {
      setError("logout failed — could not reach the server");
    }
  };

  const paste = async (authJson: string, onSaved: () => void) => {
    try {
      const failure = await codexPasteAuth(authJson);
      if (failure !== null) {
        setError(failure);
        return;
      }
      onSaved();
      await onChanged();
    } catch {
      setError("save failed — could not reach the server");
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
        panel === "none" && (
          <>
            <Button size="sm" variant="outline" disabled={busy || browserStarting} onClick={() => void startBrowser()}>
              {browserStarting ? "Starting…" : "Log in with ChatGPT"}
            </Button>
            <button
              type="button"
              className="text-muted-foreground underline underline-offset-2"
              onClick={() => setPanel("device")}
            >
              Use a device code instead
            </button>
          </>
        )
      )}
      {!codex.configured && codex.status && panel === "none" && (
        <span className={`${LABEL} w-full`}>{codex.status}</span>
      )}

      {panel === "browser" && browser && (
        <div className="flex w-full flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2.5">
          <span className={LABEL}>
            Sign in, pick your workspace, then paste the localhost URL your browser ends up on back here — the page
            will say it can&apos;t connect; that&apos;s expected.
          </span>
          <a
            className="rounded bg-muted px-2 py-1.5 font-mono text-xs break-all text-foreground underline underline-offset-2"
            href={browser.authorizeUrl}
            target="_blank"
            rel="noreferrer"
          >
            {browser.authorizeUrl}
          </a>
          <span className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void copyAuthorizeUrl()}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          </span>
          <input
            aria-label="Callback URL"
            className="h-8 w-full rounded-lg border border-border bg-background px-2 font-mono text-xs text-foreground"
            spellCheck={false}
            value={callbackUrl}
            onChange={(e) => setCallbackUrl(e.target.value)}
            placeholder="http://localhost:1455/auth/callback?code=…&state=…"
          />
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={completing || !callbackUrl.trim()}
              onClick={() => void completeBrowser()}
            >
              {completing ? "Completing…" : "Complete login"}
            </Button>
            <button type="button" className="text-muted-foreground underline underline-offset-2" onClick={closePanel}>
              Cancel
            </button>
          </span>
        </div>
      )}

      {panel === "device" && (
        <div className="flex w-full flex-col gap-1 rounded-lg border border-border bg-background px-3 py-2.5">
          {devicePhase === "waiting" && deviceLogin ? (
            <>
              <span className={LABEL}>Open the link, sign in with your ChatGPT account, and approve this code:</span>
              <span className="w-fit rounded bg-muted px-2 py-1 font-mono text-lg tracking-widest select-all">
                {deviceLogin.userCode}
              </span>
              <a
                className="text-muted-foreground break-all underline underline-offset-2"
                href={deviceLogin.verificationUrl}
                target="_blank"
                rel="noreferrer"
              >
                {deviceLogin.verificationUrl}
              </a>
              <span className="flex items-center gap-3">
                <span className={LABEL}>waiting for approval…</span>
                <button type="button" className="text-muted-foreground underline underline-offset-2" onClick={closePanel}>
                  Cancel
                </button>
              </span>
            </>
          ) : (
            <>
              <span className={LABEL}>
                Device codes are blocked on some workspaces; if the browser flow above fails, this one may too.
              </span>
              <span className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={devicePhase === "starting"} onClick={() => void startDevice()}>
                  {devicePhase === "starting" ? "Starting…" : "Get a device code"}
                </Button>
                <button type="button" className="text-muted-foreground underline underline-offset-2" onClick={closePanel}>
                  Close
                </button>
              </span>
            </>
          )}
        </div>
      )}

      {panel === "none" && !codex.configured && <PasteDisclosure onPaste={paste} />}

      {error && (
        <span role="alert" className={`${LABEL} w-full text-destructive`}>
          {error}
        </span>
      )}
    </li>
  );
}

/** The headless fallback: paste the auth.json `codex login` writes. */
function PasteDisclosure({
  onPaste,
}: {
  onPaste: (authJson: string, onSaved: () => void) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className="text-muted-foreground underline underline-offset-2"
        onClick={() => setOpen(true)}
      >
        Paste auth.json instead
      </button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2.5">
      <label className={LABEL} htmlFor="codex-auth-json">
        The auth.json `codex login` writes (on any machine with a browser) — the documented fallback:
      </label>
      <textarea
        id="codex-auth-json"
        className="min-h-24 w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='{"auth_mode":"chatgpt",…}'
      />
      <span className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={saving || !text.trim()}
          onClick={() => {
            setSaving(true);
            void onPaste(text, () => {
              setOpen(false);
              setText("");
            }).finally(() => setSaving(false));
          }}
        >
          Save
        </Button>
        <button
          type="button"
          className="text-muted-foreground underline underline-offset-2"
          onClick={() => {
            setOpen(false);
            setText("");
          }}
        >
          Close
        </button>
      </span>
    </div>
  );
}

/** "logged in · expires in 41 days" — the access-token expiry, when known. */
function loginExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return "logged in";
  const days = Math.floor((expiresAt - Date.now()) / 86_400_000);
  return days >= 0 ? `logged in · expires in ${days} day${days === 1 ? "" : "s"}` : "logged in";
}
