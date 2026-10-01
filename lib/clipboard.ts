/**
 * Copy text to the clipboard across secure and insecure origins.
 *
 * The async Clipboard API (navigator.clipboard) is only exposed in
 * secure contexts. sweatshop is browsed over plain http on the LAN
 * (only localhost:3300 is a secure context), so the primary path is
 * often absent — the legacy execCommand("copy") fallback covers it.
 * execCommand is deprecated but universally supported and works when
 * called synchronously within a user gesture (a click handler).
 *
 * Returns whether the copy landed; callers decide how to react to
 * failure (the message copy button is a silent no-op, matching the
 * pre-helper behavior when nothing can be done).
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Denied (e.g. not focused) — try the legacy path below.
    }
  }

  const doc = globalThis.document;
  if (!doc?.body) return false;

  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  // Off-screen and inert: never visible, never scrolled to.
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  doc.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = doc.execCommand("copy");
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}
