import { describe, expect, it } from "vitest";
import { routePickerLabel } from "../components/route-picker";
import { hasBoundSandbox } from "../components/composer-settings";
import type { ModelsView } from "../lib/providers/catalog-view";
import type { ConversationSandboxViewData } from "../components/sandbox-view";

/**
 * 0080: the mobile settings chip's two pure inputs — the short model
 * label it borrows from `RoutePicker`'s own trigger text, and whether
 * to show the "a sandbox is bound" dot.
 */

const view: ModelsView = {
  providers: [
    {
      id: "glm",
      label: "GLM (Z.AI)",
      available: true,
      allowed: true,
      models: [{ id: "glm-5.3-flash", label: "GLM 5.3 Flash", contextWindow: 128_000, maxTokens: 8_000 }],
    },
  ],
  claude: { configured: false, allowed: true, models: [] },
  cursor: { configured: false, allowed: true, models: [], status: null, expiresAt: null },
  codex: { configured: false, allowed: true, models: [], status: null, expiresAt: null, accountId: null },
  piAllowed: true,
  defaults: { chat: null, titles: null },
  project: null,
} as unknown as ModelsView;

describe("routePickerLabel (0080: shared by RoutePicker's trigger and the mobile chip)", () => {
  it("shows the picked model's short label", () => {
    expect(routePickerLabel({ provider: "glm", model: "glm-5.3-flash" }, view)).toBe("GLM · GLM 5.3 Flash");
  });

  it("falls back to 'Default · <inheritLabel>' with no pick", () => {
    expect(routePickerLabel(null, view, "GLM · GLM 5.3 Flash")).toBe("Default · GLM · GLM 5.3 Flash");
  });

  it("falls back to 'Pick a model' with neither", () => {
    expect(routePickerLabel(null, view)).toBe("Pick a model");
  });
});

describe("hasBoundSandbox (0080: the mobile chip's bound-sandbox dot)", () => {
  it("a fresh (editable) chat is bound once anything but none/auto is chosen", () => {
    expect(hasBoundSandbox("none", true, null)).toBe(false);
    expect(hasBoundSandbox("auto", true, null)).toBe(false);
    expect(hasBoundSandbox("attached:sbx_1", true, null)).toBe(true);
  });

  it("a started chat is bound only once its view reports own/attached", () => {
    const none: ConversationSandboxViewData = { state: { kind: "none" }, sandboxes: {} };
    const pending: ConversationSandboxViewData = { state: { kind: "pending" }, sandboxes: {} };
    const own: ConversationSandboxViewData = { state: { kind: "own", sandboxId: "s1", workDir: "/w" }, sandboxes: {} };
    const attached: ConversationSandboxViewData = { state: { kind: "attached", sandboxId: "s1", workDir: "/w" }, sandboxes: {} };
    expect(hasBoundSandbox("x", false, null)).toBe(false);
    expect(hasBoundSandbox("x", false, none)).toBe(false);
    expect(hasBoundSandbox("x", false, pending)).toBe(false);
    expect(hasBoundSandbox("x", false, own)).toBe(true);
    expect(hasBoundSandbox("x", false, attached)).toBe(true);
  });
});
