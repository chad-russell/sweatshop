import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { conversations, projects } from "../db/schema";
import { POST as createFolderRoute } from "../app/api/folders/route";
import { DELETE as deleteFolderRoute, PATCH as patchFolder } from "../app/api/folders/[id]/route";
import { DELETE as deleteConvo, PATCH as patchConvo } from "../app/api/conversations/[id]/route";

const tdb = openDb(process.env.SWEATSHOP_DB!);
tdb.insert(projects).values({ id: "api-p", name: "api-p", createdAt: 1 }).onConflictDoNothing().run();
tdb.insert(conversations).values({ id: "wrun_api_1", projectId: "api-p", createdAt: 1, updatedAt: 1 }).run();

const json = (body: unknown) =>
  new Request("http://x", { method: "POST", body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("organization routes", () => {
  it("creates, files, rejects, and deletes with the right statuses", async () => {
    const created = await createFolderRoute(json({ name: "Plans", projectId: "api-p" }));
    expect(created.status).toBe(201);
    const { folder } = await created.json();

    expect((await createFolderRoute(json({ name: "plans", projectId: "api-p" }))).status).toBe(409);
    expect((await createFolderRoute(json({ name: "" }))).status).toBe(400);

    expect((await patchConvo(json({ folderId: folder.id }), ctx("wrun_api_1"))).status).toBe(200);
    const other = await (await createFolderRoute(json({ name: "Chat folder", projectId: null }))).json();
    expect((await patchConvo(json({ folderId: other.folder.id }), ctx("wrun_api_1"))).status).toBe(409);
    expect((await patchConvo(json({ folderId: "nope" }), ctx("wrun_api_1"))).status).toBe(404);
    expect((await patchConvo(json({ folderId: 5 }), ctx("wrun_api_1"))).status).toBe(400);

    expect((await patchFolder(json({ parentId: folder.id }), ctx(folder.id))).status).toBe(409); // cycle
    expect((await deleteFolderRoute(new Request("http://x"), ctx(folder.id))).status).toBe(200);
  });

  it("only deletes forever from the trash", async () => {
    expect((await deleteConvo(new Request("http://x"), ctx("wrun_api_1"))).status).toBe(400);
    expect((await patchConvo(json({ trashed: true }), ctx("wrun_api_1"))).status).toBe(200);
    expect((await deleteConvo(new Request("http://x"), ctx("wrun_api_1"))).status).toBe(200);
    expect((await deleteConvo(new Request("http://x"), ctx("wrun_api_1"))).status).toBe(404);
  });

  it("rejects non-object bodies", async () => {
    expect((await patchConvo(json([1]), ctx("wrun_api_1"))).status).toBe(400);
  });
});
