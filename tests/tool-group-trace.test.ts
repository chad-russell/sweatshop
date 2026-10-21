import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ToolGroupView } from "../components/ai-elements/tool-group";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "../components/ui/trace";
import { groupParts, type PartLike } from "../lib/tool-views/groups";

const parts: PartLike[] = [
  { type: "tool-bash", state: "output-available", input: { command: "ls" }, output: { exitCode: 0 } },
  { type: "tool-bash", state: "output-available", input: { command: "false" }, output: { exitCode: 1 } },
  { type: "tool-bash", state: "output-available", input: { command: "pwd" }, output: { exitCode: 0 } },
];

function renderGroup(input: PartLike[]) {
  const group = groupParts(input)[0]!;
  if (group.kind !== "group") throw new Error("expected group");
  const render = vi.fn(() => h("div", null, "Specialized card"));
  const html = renderToStaticMarkup(h(ToolGroupView, { group, render }));
  return { html, render };
}

describe("tool group trace", () => {
  it("keeps the group collapsed and defers specialized card rendering", () => {
    const { html, render } = renderGroup(parts);
    expect(html).toContain('aria-label="Show calls: ran 3 commands; completed · 1 failed call"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("completed · 1 failed call");
    expect(html).toContain("text-warning");
    expect(html).not.toContain("border-destructive");
    expect(html).not.toContain("Specialized card");
    expect(render).not.toHaveBeenCalled();
  });

  it("shows the current action, not an old failure, while work continues", () => {
    const { html } = renderGroup([
      ...parts,
      { type: "tool-bash", state: "input-available", input: { command: "rg origins", description: "Check auth origins" } },
    ]);
    expect(html).toContain("running · 1 failed call");
    expect(html).toContain("Check auth origins");
    expect(html).toContain("text-info");
  });

  it("uses Radix's button, expanded state and content relationship for each step", () => {
    const html = renderToStaticMarkup(h(Trace, null,
      h(TraceCollapsible, { defaultOpen: true },
        h(TraceCollapsibleTrigger, null,
          h(TraceLine, { status: "error" },
            h(TraceIcon, null, "!"),
            h(TraceTitle, null, "Check auth origins"),
          ),
        ),
        h(TraceCollapsibleContent, null, h("pre", null, "command output")),
      ),
    ));
    expect(html).toContain("<button");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="');
    expect(html).toContain('data-status="error"');
    expect(html).toContain('data-slot="trace-icon" aria-hidden="true"');
    expect(html).toContain('data-slot="trace-collapsible-content-inner"');
    expect(html).toContain("border-l");
    expect(html).toContain("command output");
  });

  it("leaves a closed step's output hidden", () => {
    const html = renderToStaticMarkup(h(TraceCollapsible, null,
      h(TraceCollapsibleTrigger, null, h(TraceLine, null, h(TraceTitle, null, "Read docs"))),
      h(TraceCollapsibleContent, null, "Hidden output"),
    ));
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Hidden output");
  });
});
