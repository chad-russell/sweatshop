import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CancelCallButton } from "../components/cancel-call-button";
import { HarnessSessionView } from "../components/harness-session-view";
import { NavDrawerProvider } from "../components/sidebar/nav-drawer";

// AppHeader's NavTrigger needs a router pathname + the drawer provider —
// neither exists outside a mounted Next app, so both are stubbed for
// this static-markup render.
vi.mock("next/navigation", () => ({ usePathname: () => "/h/pi/c_1" }));

function renderView(props: Parameters<typeof HarnessSessionView>[0]) {
  return renderToStaticMarkup(h(NavDrawerProvider, null, h(HarnessSessionView, props)));
}

describe("CancelCallButton", () => {
  it("renders a Stop control for the given call", () => {
    const html = renderToStaticMarkup(h(CancelCallButton, { callId: "hc_abc", label: "Claude Code" }));
    expect(html).toContain("Stop");
    expect(html).toContain("<button");
  });
});

describe("HarnessSessionView header tone", () => {
  const base = {
    initialEvents: [],
    sandbox: null,
    parent: { id: "c_1", title: "Thread", exists: true, projectId: null, projectName: null },
  };

  it("gives a cancelled run a neutral tone, not the success green", () => {
    const html = renderView({
      ...base,
      initialRun: { sessionId: "c_1", kind: "pi", status: "cancelled", toolCalls: 2, startedAt: 0, lastAt: 1 },
    });
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain("text-success");
  });

  it("still shows the success tone for a completed run", () => {
    const html = renderView({
      ...base,
      initialRun: { sessionId: "c_1", kind: "pi", status: "completed", toolCalls: 2, startedAt: 0, lastAt: 1 },
    });
    expect(html).toContain("text-success");
  });

  it("shows the Cancel button while running when a callId is given", () => {
    const html = renderView({
      ...base,
      initialRun: { sessionId: "c_1", kind: "pi", status: "running", toolCalls: 0, startedAt: 0, lastAt: 1 },
      callId: "hc_live",
    });
    expect(html).toContain("Stop");
  });

  it("shows no Cancel button once settled", () => {
    const html = renderView({
      ...base,
      initialRun: { sessionId: "c_1", kind: "pi", status: "completed", toolCalls: 0, startedAt: 0, lastAt: 1 },
      callId: "hc_live",
    });
    expect(html).not.toContain("Stop");
  });
});
