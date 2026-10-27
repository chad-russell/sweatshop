/** Terminal-styled block for a host exec: optional description, a
 *  user@host · address · timeout line, and the command as it will run.
 *  Shared by the inbox approval card and the chat's host-exec card. */
export function ExecCommandBlock({
  user,
  host,
  address,
  timeoutSec,
  command,
  description,
  note,
}: {
  user?: string;
  host?: string;
  address?: string;
  timeoutSec: number;
  command?: string;
  description?: string;
  /** Extra muted text after the timeout. */
  note?: string;
}) {
  const who = host ? (user ? `${user}@${host}` : host) : undefined;
  return (
    <div className="rounded-md border border-terminal-border bg-terminal px-3 py-2 font-mono text-xs">
      {description && (
        <p className="mb-1 font-sans text-[13px] font-medium text-terminal-foreground">{description}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 text-terminal-muted">
        {who && <span className="text-terminal-foreground">{who}</span>}
        {who && address && <span aria-hidden>·</span>}
        {address && <span>{address}</span>}
        {(who || address) && <span aria-hidden>·</span>}
        <span>{timeoutSec}s timeout</span>
        {note && (
          <>
            <span aria-hidden>·</span>
            <span>{note}</span>
          </>
        )}
      </div>
      <pre className="mt-1.5 whitespace-pre-wrap text-terminal-foreground">$ {command ?? "…"}</pre>
    </div>
  );
}
