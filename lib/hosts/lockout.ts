/**
 * 0043 amendment: lockout-sensitive commands always ask, even with a
 * chat's auto-approve toggle on — the services an exec call could use to
 * strand itself (SSH, networking, the firewall, the gateway/proxy,
 * power). A case-insensitive, word-boundary match on the command text;
 * a GUARD RAIL, not a security boundary — the model can still phrase its
 * way around it, same as any prompt-level rule.
 */

const LOCKOUT_PATTERNS: RegExp[] = [
  /\bsshd\b/i,
  /\bssh\.service\b/i,
  /\bssh\.socket\b/i,
  // Debian/Ubuntu name the unit plain `ssh` — catch it as a systemctl/service target.
  /\b(systemctl|service)\b[^;&|\n]*\bssh\b/i,
  /\bnetworkd\b/i,
  /\bnetworkmanager\b/i,
  /\bnftables\b/i,
  /\biptables\b/i,
  /\bfirewall\b/i,
  /\bfirewalld\b/i,
  /\bufw\b/i,
  /\bnebula\b/i,
  /\bcaddy\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\bsuspend\b/i,
  /\bnixos-rebuild\s+(switch|boot)\b/i,
  /\bip\s+(link|addr|route)\b/i,
];

export function isLockoutSensitiveCommand(command: string): boolean {
  return LOCKOUT_PATTERNS.some((pattern) => pattern.test(command));
}
