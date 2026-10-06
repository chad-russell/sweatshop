import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0019 opt-in integration test: the New-preview dialog's FIRST-FILL
 * path against the real substrate — real podman sandboxes, a real git
 * upstream (a git-daemon container, so the sandbox clones over the
 * network like it would from a forge), real npm, a real HTTP server in
 * the sandbox, probed over the harness network. The requests are built
 * by the dialog's own pure mapper (`overridesFromSetupForm`) and sent
 * through the real route handlers, so what is exercised is exactly what
 * the dialog sends and receives; only the React markup is not.
 *
 * Needs podman and the dev container's harness network, so run it
 * through ./dev:
 *   PREVIEW_E2E=1 ./dev exec -- npx vitest run tests/preview-first-fill.integration.test.ts
 */

const enabled = process.env.PREVIEW_E2E === "1";
const d = enabled ? describe : describe.skip;
const exec = promisify(execFile);
const docker = (...args: string[]) => exec("docker", args, { maxBuffer: 16 * 1024 * 1024 });

const UPSTREAM = `pv-e2e-upstream-${Date.now()}`;
const PROJECT = "p_e2e_firstfill";
const REPO = `${PROJECT}/app`;

// A package whose `dev` script is a tiny HTTP server that reports the
// env it booted with — proof of what the platform and the setup delivered.
const SERVER_JS =
  "require('http').createServer((q,s)=>s.end(JSON.stringify({" +
  "greeting:process.env.GREETING||null,url:process.env.PREVIEW_URL||null,port:process.env.PORT||null" +
  "}))).listen(process.env.PORT||3000,'0.0.0.0')";

const UPSTREAM_SCRIPT = `
set -e
mkdir -p /tmp/seed /tmp/srv && cd /tmp/seed
git init -q -b main && git config user.email t@t && git config user.name t
cat > package.json <<'EOF'
{"name":"e2e-app","private":true,"scripts":{"dev":"node server.js"}}
EOF
cat > server.js <<'EOF'
${SERVER_JS}
EOF
git add -A && git commit -qm init
git clone -q --bare /tmp/seed /tmp/srv/app.git
exec git daemon --base-path=/tmp/srv --export-all --reuseaddr --listen=0.0.0.0 --port=9418
`;

async function waitFor<T>(what: string, fn: () => Promise<T | null | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const containerExists = (ref: string) =>
  docker("inspect", "-f", "{{.State.Running}}", ref).then(
    (r) => r.stdout.trim() === "true",
    () => false,
  );

d("0019 first-fill preview (live)", () => {
  const sandboxes = new Set<string>();
  let repoId = "";
  let url = "";
  // test state handed from one step to the next (the steps are one story)
  let pendingId = "";
  let candidate: { dir: string; install: string; command: string; port: number } | null = null;
  // modules are loaded after tests/setup.ts has pointed SWEATSHOP_DB at the temp db
  let m: Awaited<ReturnType<typeof load>>;
  const load = async () => ({
    db: (await import("../db")).db,
    schema: await import("../db/schema"),
    setups: await import("../db/preview-setups"),
    previews: await import("../db/previews"),
    sandboxes: await import("../db/sandboxes"),
    form: await import("../components/project/setup-form"),
    lease: await import("../lib/sandboxes/lease"),
    createRoute: await import("../app/api/previews/route"),
    idRoute: await import("../app/api/previews/[id]/route"),
    setupRoute: await import("../app/api/previews/setup/route"),
  });

  // route responses, loosely typed on purpose: assertions name what matters
  type Body = { error?: string; preview: Record<string, unknown> & { id: string; sandboxId: string; url: string; status: string }; candidates?: { dir: string; install: string; command: string; port: number }[] };
  const json = async (res: Response) => (await res.json()) as Body;
  const post = (body: unknown) =>
    new Request("http://test/api/previews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const action = (id: string, body: unknown) =>
    new Request(`http://test/api/previews/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  /** GET the running preview from inside the harness network. */
  const served = async (sandboxRef: string) =>
    (await (await fetch(`http://${sandboxRef}:3000/`, { signal: AbortSignal.timeout(5_000) })).json()) as {
      greeting: string | null;
      url: string | null;
      port: string | null;
    };

  beforeAll(async () => {
    await docker("run", "-d", "--name", UPSTREAM, "localhost/sweatshop-sandbox", "bash", "-lc", UPSTREAM_SCRIPT);
    await waitFor("git daemon", async () => {
      const r = await docker("exec", UPSTREAM, "git", "ls-remote", "git://127.0.0.1/app.git");
      return r.stdout.includes("refs/heads/main");
    });
    const ip = (
      await docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", UPSTREAM)
    ).stdout.trim().split(/\s+/)[0]!;

    m = await load();
    repoId = REPO;
    m.db().insert(m.schema.projects).values({ id: PROJECT, name: "E2E first fill", createdAt: Date.now() }).run();
    m.db()
      .insert(m.schema.projectRepos)
      .values({ id: repoId, projectId: PROJECT, name: "app", url: `git://${ip}/app.git`, createdAt: Date.now() })
      .run();
  }, 120_000);

  afterAll(async () => {
    for (const id of sandboxes) await m.lease.destroySandbox(id).catch(() => undefined);
    await docker("rm", "-f", UPSTREAM).catch(() => undefined);
  }, 120_000);

  it("no setup: create provisions a real sandbox, scans the checkout, and returns candidates", async () => {
    const body = m.form.overridesFromSetupForm(m.form.emptySetupForm, repoId, "");
    expect(body).toEqual({}); // nothing filled in: the server must scan, not guess

    const res = await m.createRoute.POST(post({ projectId: PROJECT, repoId, branch: "main", ...body }));
    const out = await json(res);
    expect(res.status).toBe(200);
    expect(out.preview.status).toBe("provisioning");
    sandboxes.add(out.preview.sandboxId);

    expect(out.candidates).toEqual([
      expect.objectContaining({ dir: ".", command: "npm run dev", install: "npm install", port: 3000 }),
    ]);
    expect(await containerExists(m.sandboxes.getLease(m.db(), out.preview.sandboxId)!.ref)).toBe(true);
    expect(m.setups.getPreviewSetup(m.db(), PROJECT)).toEqual({ ok: true, setup: null });

    pendingId = out.preview.id;
    candidate = out.candidates![0]!;
  }, 180_000);

  it("launching the picked candidate serves it, saves the setup, and leaves the row without an env copy", async () => {
    const c = candidate!;
    // what the dialog does on Launch: the candidate fills the editor, the user adds env
    const body = m.form.overridesFromSetupForm(
      { ...m.form.emptySetupForm, workDir: c.dir, install: c.install, command: c.command, port: String(c.port), envText: "GREETING=hello" },
      repoId,
      "e2e",
    );
    if ("error" in body) throw new Error(String(body.error));

    const res = await m.idRoute.POST(action(pendingId, { action: "confirm", ...body }), params(pendingId));
    const out = await json(res);
    expect(res.status).toBe(200);
    expect(out.error).toBeUndefined();
    expect(out.preview).toMatchObject({ status: "healthy", label: "e2e", command: "npm run dev", port: 3000 });
    url = out.preview.url;

    // really serving, with the setup's env and the platform's vars
    expect(await served(m.sandboxes.getLease(m.db(), out.preview.sandboxId)!.ref)).toEqual({
      greeting: "hello",
      url,
      port: "3000",
    });

    // first fill saved the project's setup (env included) ...
    const setup = m.setups.getPreviewSetup(m.db(), PROJECT);
    if (!setup.ok || !setup.setup) throw new Error("setup not saved");
    expect(setup.setup.definition).toMatchObject({
      repo: repoId, workDir: ".", install: "npm install", command: "npm run dev", port: 3000, env: { GREETING: "hello" },
    });
    // ... and the row keeps NO copy of it (0019: rows store deviations only)
    expect(m.previews.getPreview(m.db(), pendingId)?.env).toBeNull();
  }, 240_000);

  it("editing the setup's env on the project page reaches the preview on its next restart", async () => {
    const current = m.setups.getPreviewSetup(m.db(), PROJECT);
    if (!current.ok || !current.setup) throw new Error("no setup");
    // the project page's Save setup: PUT the edited definition
    const put = await m.setupRoute.PUT(
      new Request("http://test/api/previews/setup", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: PROJECT, definition: { ...current.setup.definition, env: { GREETING: "rotated" } } }),
      }),
    );
    expect(put.status).toBe(200);

    const res = await m.idRoute.POST(action(pendingId, { action: "restart" }), params(pendingId));
    const out = await json(res);
    expect(out.preview.status).toBe("healthy");
    expect(await served(m.sandboxes.getLease(m.db(), out.preview.sandboxId)!.ref)).toMatchObject({ greeting: "rotated" });
  }, 240_000);

  it("with a setup, create is one shot and the dialog's label-only request never rewrites the setup", async () => {
    const before = m.setups.getPreviewSetup(m.db(), PROJECT);

    // exactly what the dialog sends when a setup exists: only the label
    const res = await m.createRoute.POST(post({ projectId: PROJECT, repoId, branch: "main", label: "second" }));
    const out = await json(res);
    expect(res.status).toBe(200);
    expect(out.candidates).toBeUndefined();
    expect(out.preview).toMatchObject({ status: "healthy", label: "second", overridesSetup: false });
    sandboxes.add(out.preview.sandboxId);

    expect(await served(m.sandboxes.getLease(m.db(), out.preview.sandboxId)!.ref)).toMatchObject({ greeting: "rotated" });
    expect(m.setups.getPreviewSetup(m.db(), PROJECT)).toEqual(before); // untouched, updatedAt included
  }, 240_000);

  it("abandoning the dialog deletes the provisioning preview and destroys its sandbox", async () => {
    m.setups.deletePreviewSetup(m.db(), PROJECT); // back to first fill
    const created = await json(await m.createRoute.POST(post({ projectId: PROJECT, repoId, branch: "main" })));
    expect(created.preview.status).toBe("provisioning");
    sandboxes.add(created.preview.sandboxId);
    const ref = m.sandboxes.getLease(m.db(), created.preview.sandboxId)!.ref;
    expect(await containerExists(ref)).toBe(true);

    // what closing the dialog does
    const res = await m.idRoute.POST(action(created.preview.id, { action: "delete" }), params(created.preview.id));
    expect(res.status).toBe(200);

    expect(m.previews.getPreview(m.db(), created.preview.id)?.deletedAt).toBeGreaterThan(0);
    expect(m.sandboxes.getLease(m.db(), created.preview.sandboxId)?.status).toBe("destroyed");
    expect(await containerExists(ref)).toBe(false);
  }, 240_000);
});
