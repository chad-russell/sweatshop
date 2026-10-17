import { describe, expect, it } from "vitest";
import { isLockoutSensitiveCommand } from "../lib/hosts/lockout";

/**
 * 0043 amendment: the lockout-sensitive matcher is a guard rail (word-
 * boundary, case-insensitive), not a security boundary — these tests
 * cover the documented list and a few plain commands that must NOT trip
 * it (a lockout toggle that fires on every command is useless).
 */

describe("isLockoutSensitiveCommand", () => {
  it.each([
    "systemctl restart sshd",
    "SYSTEMCTL RESTART SSHD",
    "systemctl status ssh.service",
    "systemctl stop ssh.socket",
    "systemctl restart systemd-networkd",
    "nmcli — NetworkManager status",
    "systemctl restart nftables",
    "iptables -L",
    "ufw reload # firewall",
    "systemctl restart nebula",
    "systemctl restart caddy",
    "reboot",
    "shutdown -h now",
    "poweroff",
    "nixos-rebuild switch",
    "nixos-rebuild boot",
    "sudo nixos-rebuild   switch --flake .#bee",
    "ip link set eth0 down",
    "ip addr show",
    "ip route del default",
    // review: Debian/Ubuntu unit names and other plain spellings
    "systemctl restart ssh",
    "sudo systemctl stop ssh",
    "service ssh restart",
    "systemctl stop firewalld",
    "ufw disable",
    "halt",
    "systemctl suspend",
  ])("flags %j", (command) => {
    expect(isLockoutSensitiveCommand(command)).toBe(true);
  });

  it.each([
    "ls -la",
    "cat /var/log/syslog",
    "journalctl -u sweatshop -n 50",
    "df -h",
    "npm install",
    "git status",
    "curl http://localhost:3000/health",
    "zip -r out.zip .", // contains "ip" but not as a standalone word/command
    "pip install requests", // contains "ip" mid-word
    "skip this one",
    "ssh-keygen -l -f ~/.ssh/known_hosts", // ssh tooling, not the service
    "systemctl status sweatshop && ls ~/.ssh", // ssh after a separator, not a systemctl target
  ])("does not flag %j", (command) => {
    expect(isLockoutSensitiveCommand(command)).toBe(false);
  });

  it("is case-insensitive and word-boundary based, not a substring match", () => {
    expect(isLockoutSensitiveCommand("REBOOT")).toBe(true);
    expect(isLockoutSensitiveCommand("rebooting is not a word here")).toBe(false);
  });
});
