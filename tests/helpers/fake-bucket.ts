import type { S3Gateway } from "../../lib/skills/store";

/** An in-memory bucket behind the store's S3Gateway seam — no network. */
export class FakeBucket implements S3Gateway {
  objects = new Map<string, string>();
  puts: string[] = [];
  /** Every delete, in call order — tests assert manifest-first ordering. */
  deletes: string[] = [];
  lists = 0;
  failList: Error | null = null;
  failPutAfter: number | null = null;
  failDeleteOn: string | null = null;

  async list(prefix: string) {
    this.lists += 1;
    if (this.failList) throw this.failList;
    return [...this.objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, body]) => ({ key, size: new TextEncoder().encode(body).byteLength }));
  }

  async get(key: string) {
    return this.objects.get(key) ?? null;
  }

  async put(key: string, body: string) {
    if (this.failPutAfter !== null && this.puts.length >= this.failPutAfter) throw new Error("put failed");
    this.puts.push(key);
    this.objects.set(key, body);
  }

  async delete(key: string) {
    if (this.failDeleteOn !== null && key.endsWith(this.failDeleteOn)) throw new Error("delete failed");
    this.deletes.push(key);
    this.objects.delete(key);
  }

  /** Seed a consistent skill (manifest written last, sizes matching). */
  seed(id: string, body: string, files: Record<string, string> = {}, prefix = "") {
    const all: Record<string, string> = { "SKILL.md": body, ...files };
    for (const [path, content] of Object.entries(all)) this.objects.set(`${prefix}${id}/${path}`, content);
    this.objects.set(
      `${prefix}${id}/manifest.json`,
      JSON.stringify({
        files: Object.keys(all),
        sizes: Object.fromEntries(Object.entries(all).map(([p, c]) => [p, new TextEncoder().encode(c).byteLength])),
        updatedAt: "2026-10-29T00:00:00.000Z",
      }),
    );
  }
}

export const skillMd = (description: string, body = "# Runbook\n\nDo the thing.", extra = "") =>
  `---\ndescription: ${description}\n${extra}---\n${body}\n`;
