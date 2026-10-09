import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { attachmentsDir } from "@/lib/agent/tools/screenshot";

/**
 * 0035: serve an attached screenshot (data/attachments/<id>.png, written
 * by lib/agent/tools/screenshot). Ids are generated (att_<hex>), so the
 * charset check is the whole traversal story; files are immutable.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^att_[a-z0-9]+$/.test(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const file = path.join(attachmentsDir(), `${id}.png`);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new NextResponse(stream, {
      headers: {
        "content-type": "image/png",
        "content-length": String(info.size),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
