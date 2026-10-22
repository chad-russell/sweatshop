import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LegacyPlanCard } from "../components/legacy-plan-card";
import { isLegacyPlanSnapshot } from "../lib/legacy-plan";

describe("legacy present_plan compatibility", () => {
  it("recognizes and renders a historical result read-only", () => {
    const output = { ok: true, version: 4, markdown: "# Old plan\n\n- [x] finished", status: "review" };
    expect(isLegacyPlanSnapshot(output)).toBe(true);
    const html = renderToStaticMarkup(createElement(LegacyPlanCard, { output }));
    expect(html).toContain("Plan v4");
    expect(html).toContain("legacy · read only");
    expect(html).toContain("Old plan");
  });
});
