import { describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
import { projects } from "../db/schema";
import {
  addProjectHost,
  getProjectHostByName,
  listProjectHosts,
  parseAddress,
  removeProjectHost,
  setHostKeyFingerprint,
} from "../db/hosts";
import { listHostCommands, recordHostCommand, resolveHostCommand } from "../db/host-commands";
import { deleteConversationForever } from "../db/organize";

/**
 * 0043 — the registry and audit stores (the per-worker temp db carries
 * the real migrations). No transport, no env, no sockets.
 */

const PROJECT = "p_0043";
db().insert(projects).values({ id: PROJECT, name: "Hosts", createdAt: 0 }).onConflictDoNothing().run();

function chat(name: string): string {
  const id = `c_0043_${name}`;
  ensureConversation(db(), id, PROJECT);
  return id;
}

// ── parseAddress ─────────────────────────────────────────────────────

describe("parseAddress", () => {
  it("takes host, host:port, and bracketed IPv6 with a port", () => {
    expect(parseAddress("10.10.0.6")).toEqual({ host: "10.10.0.6", port: 22 });
    expect(parseAddress("bee.lan:2222")).toEqual({ host: "bee.lan", port: 2222 });
    expect(parseAddress("[2001:db8::1]:2222")).toEqual({ host: "2001:db8::1", port: 2222 });
    expect(parseAddress("2001:db8::1")).toEqual({ host: "2001:db8::1", port: 22 });
  });
  it("rejects junk", () => {
    expect(parseAddress("")).toBeNull();
    expect(parseAddress("a b")).toBeNull();
    expect(parseAddress("h:0")).toBeNull();
    expect(parseAddress("h:99999")).toBeNull();
  });
});

// ── the registry store ───────────────────────────────────────────────

describe("project hosts store", () => {
  it("adds and lists, lowercasing names, ordered by name", () => {
    const a = addProjectHost(db(), PROJECT, { name: "Bees", address: "10.10.0.6", user: "crussell" });
    expect(a.ok).toBe(true);
    addProjectHost(db(), PROJECT, { name: "bee", address: "10.10.0.12", user: "crussell", apiBase: null });
    const names = listProjectHosts(db(), PROJECT).map((h) => h.name);
    expect(names).toEqual(["bee", "bees"]);
    expect(getProjectHostByName(db(), PROJECT, "bee")?.address).toBe("10.10.0.12");
  });

  it("validates name, address, user, and apiBase", () => {
    const code = (input: Parameters<typeof addProjectHost>[2]) => {
      const r = addProjectHost(db(), PROJECT, input);
      expect(r.ok).toBe(false);
      if (!r.ok) return r.code;
      throw new Error("expected a refusal");
    };
    expect(code({ name: "Bad Name", address: "h", user: "u" })).toBe("invalid-name");
    expect(code({ name: "x", address: "not a host", user: "u" })).toBe("invalid-address");
    expect(code({ name: "x", address: "h", user: "" })).toBe("invalid-user");
    expect(code({ name: "x", address: "h", user: "u", apiBase: "ftp://no" })).toBe("invalid-api-base");
    expect(code({ name: "bee", address: "h", user: "u" })).toBe("conflict");
  });

  it("removes by id, keeps nothing dangling", () => {
    const r = addProjectHost(db(), PROJECT, { name: "gone", address: "h:22", user: "u" });
    if (!r.ok) throw new Error(r.message);
    expect(removeProjectHost(db(), PROJECT, r.host.id).ok).toBe(true);
    expect(getProjectHostByName(db(), PROJECT, "gone")).toBeNull();
    const again = removeProjectHost(db(), PROJECT, r.host.id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("not-found");
  });

  it("pins a fingerprint (TOFU)", () => {
    const r = addProjectHost(db(), PROJECT, { name: "pin", address: "h", user: "u" });
    if (!r.ok) throw new Error(r.message);
    setHostKeyFingerprint(db(), r.host.id, "sha256:abc");
    expect(getProjectHostByName(db(), PROJECT, "pin")?.hostKeyFp).toBe("sha256:abc");
    removeProjectHost(db(), PROJECT, r.host.id);
  });
});

// ── the audit store ──────────────────────────────────────────────────

describe("host commands store", () => {
  it("writes the row before the run and resolves it after", () => {
    const cid = chat("audit");
    recordHostCommand(db(), { id: "hx_a", conversationId: cid, hostId: "ph_x", hostName: "bee", command: "uptime" });
    let rows = listHostCommands(db(), cid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolvedAt).toBeNull();
    expect(rows[0]!.exitCode).toBeNull();

    recordHostCommand(db(), { id: "hx_b", conversationId: cid, hostId: "ph_x", hostName: "bee", command: "second" });
    resolveHostCommand(db(), "hx_b", { exitCode: 3, output: "exit 3", durationMs: 12 });
    rows = listHostCommands(db(), cid);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe("hx_b"); // newest first (id desc)
    expect(rows[0]!.exitCode).toBe(3);
    expect(rows[0]!.resolvedAt).not.toBeNull();
  });

  it("dies with the conversation, survives host removal", () => {
    const cid = chat("purge");
    const host = addProjectHost(db(), PROJECT, { name: "temp", address: "h", user: "u" });
    if (!host.ok) throw new Error(host.message);
    recordHostCommand(db(), { id: "hx_c", conversationId: cid, hostId: host.host.id, hostName: "temp", command: "x" });
    removeProjectHost(db(), PROJECT, host.host.id);
    expect(listHostCommands(db(), cid)).toHaveLength(1); // history stays
    deleteConversationForever(db(), cid);
    expect(listHostCommands(db(), cid)).toHaveLength(0); // conversation teardown
  });
});
