import { describe, expect, it } from "vitest";
import { db } from "../db";
import { listPreviewsForSandboxes } from "../db/previews";
import type { BoundSandbox } from "../db/sandboxes";
import type { HarnessStage } from "../workflows/machines/harness-agent";
import { harnessStageTools } from "../workflows/machines/harness-agent";
import { FakeSandbox, fast, networkFor } from "./helpers/fake-sandbox";

/**
 * 0036: harness stages carry the same preview family chats and agent
 * stages have — one ToolSet built against the run's binding, previews
 * attributed to the stage session, idempotent start so a later stage
 * lands on the same preview the implementer started. The scripted
 * sandbox stands in for podman (no container, no network).
 */

let n = 0;
function runLease() {
  n += 1;
  const id = `sbx_hp${n}`;
  const ref = `ref-${id}`;
  const ownerId = `mr_hp_run${n}`; // one dedicated sandbox per owner (unique index)
  db().$client
    .prepare(
      "insert into sandboxes (id, provider, ref, owner_kind, owner_id, status, last_used_at, created_at) " +
        "values (?, 'podman', ?, 'run', ?, 'running', ?, 0)",
    )
    .run(id, ref, ownerId, Date.now());
  return { sandboxId: id, ref, binding: { kind: "bound", sandboxId: id, workDir: `/work/${ownerId}`, owner: false } as BoundSandbox };
}

function stage(next: { to: string; when?: string }[]): HarnessStage {
  return { kind: "harness", harness: "pi", title: "T", instructions: "i", next };
}

async function toolsFor(s: HarnessStage, sbx: FakeSandbox, ref: string, binding: BoundSandbox) {
  return harnessStageTools({
    stage: s,
    sessionId: `${binding.workDir.slice("/work/".length)}_2`,
    runId: binding.workDir.slice("/work/".length),
    projectId: "p_hp",
    binding,
    handle: sbx.attach(ref),
    workDir: binding.workDir,
    previewDeps: { provider: sbx, network: networkFor(sbx), ...fast },
  });
}

describe("0036 harness-stage preview tools", () => {
  it("gives a harness stage the shared preview family beside its host tools", async () => {
    const sbx = new FakeSandbox();
    const { ref, binding } = runLease();
    const linear = await toolsFor(stage([{ to: "gate" }]), sbx, ref, binding);
    expect(Object.keys(linear).sort()).toEqual(
      ["get_preview_setup", "preview_status", "propose_pr", "save_preview_setup", "start_preview", "stop_preview"],
    );
    const branching = await toolsFor(stage([{ to: "a", when: "ok" }, { to: "b", when: "no" }]), sbx, ref, binding);
    expect(Object.keys(branching)).toContain("transition");
  });

  it("starts a preview in the run's binding, attributed to the stage session", async () => {
    const sbx = new FakeSandbox();
    const network = networkFor(sbx);
    const { sandboxId, ref, binding } = runLease();
    const tools = await harnessStageTools({
      stage: stage([{ to: "gate" }]),
      sessionId: `${binding.workDir.slice("/work/".length)}_2`,
      runId: binding.workDir.slice("/work/".length),
      projectId: "p_hp",
      binding,
      handle: sbx.attach(ref),
      workDir: binding.workDir,
      previewDeps: { provider: sbx, network, ...fast },
    });
    const result = await tools.start_preview!.execute!(
      { dir: `${binding.workDir}/web`, command: "pnpm run dev", port: 4173 },
      { toolCallId: "t_start", messages: [], context: {} },
    );
    expect(result).toMatchObject({
      ok: true,
      preview: { status: "healthy", sandboxId, workDir: `${binding.workDir}/web`, port: 4173 },
    });
    if (!result.ok) throw new Error("unreachable");
    expect(result.preview.url).toMatch(/^https:\/\/pv-[a-z0-9-]+\.internal\.crussell\.io$/);
    // 0016 attribution: the preview records the stage session that started it.
    const [row] = listPreviewsForSandboxes(db(), [sandboxId]);
    expect(row.startedBy).toBe(`${binding.workDir.slice("/work/".length)}_2`);
    expect(network.connected).toEqual([ref]);
  });

  it("re-starting the same dir/port returns the same preview (a later stage finds it)", async () => {
    const sbx = new FakeSandbox();
    const { ref, binding } = runLease();
    const implementer = await toolsFor(stage([{ to: "verify" }]), sbx, ref, binding);
    const first = await implementer.start_preview!.execute!(
      { dir: `${binding.workDir}/web`, command: "pnpm run dev", port: 5173 },
      { toolCallId: "t_first", messages: [], context: {} },
    );
    if (!first.ok) throw new Error("unreachable");
    // the verify stage builds its OWN ToolSet — same binding, same dir/port.
    const verifier = await toolsFor(stage([{ to: "pr-approve", when: "ok" }, { to: "implement", when: "fixes" }]), sbx, ref, binding);
    const second = await verifier.start_preview!.execute!(
      { dir: `${binding.workDir}/web`, command: "pnpm run dev", port: 5173 },
      { toolCallId: "t_second", messages: [], context: {} },
    );
    expect(second).toMatchObject({ ok: true, preview: { id: first.preview.id } });
    const listed = await verifier.preview_status!.execute!({}, { toolCallId: "t_list", messages: [], context: {} });
    expect(listed).toMatchObject({ ok: true, previews: [{ id: first.preview.id, status: "healthy" }] });
  });
});
