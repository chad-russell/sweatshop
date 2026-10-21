"use client";

import { CircleHelp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MONO } from "@/components/form-styles";

/**
 * 0038: how to get Cursor's `auth.json` into `data/harness-auth/cursor/`.
 * On macOS `agent login` keeps the tokens in the Keychain and writes no
 * file, so the settings page's "save its auth.json" needs this recipe.
 */

const MAC_SCRIPT = `mkdir -p data/harness-auth/cursor
umask 077
printf '{"accessToken":"%s","refreshToken":"%s"}\\n' \\
  "$(security find-generic-password -s cursor-access-token -w)" \\
  "$(security find-generic-password -s cursor-refresh-token -w)" \\
  > data/harness-auth/cursor/auth.json
chmod 600 data/harness-auth/cursor/auth.json`;

export function CursorLoginHelp() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="How to save the Cursor login"
          className="text-muted-foreground hover:text-foreground"
        >
          <CircleHelp className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] space-y-2">
        <p className="font-medium">Saving the Cursor login</p>
        <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
          <li>
            Run <code className={MONO}>agent login</code> on your machine and finish the browser sign-in.
          </li>
          <li>
            <b>Linux:</b> copy <code className={MONO}>~/.config/cursor/auth.json</code> to{" "}
            <code className={MONO}>data/harness-auth/cursor/auth.json</code>.
          </li>
          <li>
            <b>macOS:</b> the CLI stores tokens in the Keychain and writes no file. From the repo root, build it:
          </li>
        </ol>
        <pre className={`${MONO} overflow-x-auto rounded-md bg-muted p-2 text-[11px] leading-snug`}>{MAC_SCRIPT}</pre>
        <p className="text-xs text-muted-foreground">
          The file is read on each call, so no restart is needed. When it shows “expired”, log in again and re-run.
        </p>
      </PopoverContent>
    </Popover>
  );
}
