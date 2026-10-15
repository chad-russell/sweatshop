import { NextResponse } from "next/server";
import { isAttachmentId, readAttachmentFile } from "@/lib/attachments";

/**
 * Serve an attachment: 0035's screenshots (att_<hex>.png) and 0042's
 * uploaded images (png/jpg/webp/gif). Ids are generated (att_<hex>), so
 * the charset check is the whole traversal story; files are immutable.
 * The type comes from the file's extension, which only our own writers
 * (magic-byte checked at upload) ever choose.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isAttachmentId(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const found = await readAttachmentFile(id);
  if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(Buffer.from(found.data), {
    headers: {
      "content-type": found.mediaType,
      "content-length": String(found.data.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
