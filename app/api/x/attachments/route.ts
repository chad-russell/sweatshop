import { NextResponse } from "next/server";
import { db } from "@/db";
import { insertAttachment } from "@/db/attachments";
import {
  MAX_IMAGE_BYTES,
  newAttachmentId,
  sniffImage,
  writeAttachmentFile,
} from "@/lib/attachments";

export const dynamic = "force-dynamic";

/**
 * 0042: upload one image for the composer. Multipart form, field `file`.
 * The type is decided by the bytes (PNG/JPEG/WebP/GIF), never by the
 * client's MIME or filename. The upload is unclaimed until a send names
 * it; abandoned ones are swept after 24 h.
 */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "field `file` is required" }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json(
      { error: `image is ${(file.size / 1024 / 1024).toFixed(1)} MiB; the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MiB` },
      { status: 413 },
    );
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const mediaType = sniffImage(data);
  if (!mediaType) {
    return NextResponse.json({ error: "not a PNG, JPEG, WebP or GIF image" }, { status: 415 });
  }
  const id = newAttachmentId();
  await writeAttachmentFile(id, mediaType, data);
  insertAttachment(db(), { id, mediaType, bytes: data.byteLength });
  return NextResponse.json({ id, url: `/api/attachments/${id}`, mediaType, bytes: data.byteLength });
}
