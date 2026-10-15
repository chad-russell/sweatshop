import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import path from "node:path";

/**
 * 0042: image attachments on disk. Node-only (fs) and db-free — the row
 * bookkeeping is db/attachments.ts. Files live at
 * data/attachments/<id>.<ext>; 0035's screenshots share the directory as
 * `att_<hex>.png` with no row.
 */

/** The one attachment root: data/attachments (ATTACHMENTS_DIR overrides). */
export function attachmentsDir(): string {
  return process.env.ATTACHMENTS_DIR ?? path.join(/* turbopackIgnore: true */ process.cwd(), "data", "attachments");
}

export {
  ATTACHMENT_SCHEME,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  attachmentRef,
  isAttachmentId,
  parseAttachmentRef,
} from "./attachment-ref";
import { isAttachmentId } from "./attachment-ref";

export const IMAGE_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as const;
export type ImageMediaType = keyof typeof IMAGE_EXTENSIONS;
const MEDIA_BY_EXT = Object.fromEntries(Object.entries(IMAGE_EXTENSIONS).map(([m, e]) => [e, m])) as Record<string, ImageMediaType>;

/** Identify an image by its magic bytes — never by the client's claim. */
export function sniffImage(data: Uint8Array): ImageMediaType | null {
  const at = (i: number) => data[i];
  if (data.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (data.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (data.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (
    data.length >= 12 &&
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export const newAttachmentId = () => `att_${randomBytes(9).toString("hex")}`;

/** Write the bytes; returns the file path. */
export async function writeAttachmentFile(id: string, mediaType: ImageMediaType, data: Uint8Array): Promise<string> {
  const dir = attachmentsDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(/* turbopackIgnore: true */ dir, `${id}.${IMAGE_EXTENSIONS[mediaType]}`);
  await writeFile(file, data);
  return file;
}

/** Locate an id's file by trying each extension; null when absent. */
export async function readAttachmentFile(id: string): Promise<{ data: Uint8Array; mediaType: ImageMediaType; file: string } | null> {
  if (!isAttachmentId(id)) return null;
  for (const [ext, mediaType] of Object.entries(MEDIA_BY_EXT)) {
    const file = path.join(/* turbopackIgnore: true */ attachmentsDir(), `${id}.${ext}`);
    try {
      return { data: new Uint8Array(await readFile(file)), mediaType, file };
    } catch {
      // try the next extension
    }
  }
  return null;
}

/** Remove an id's files (every extension); best-effort. */
export async function removeAttachmentFiles(id: string): Promise<void> {
  if (!isAttachmentId(id)) return;
  await Promise.all(
    Object.keys(MEDIA_BY_EXT).map((ext) => unlink(path.join(/* turbopackIgnore: true */ attachmentsDir(), `${id}.${ext}`)).catch(() => undefined)),
  );
}

/** Sync twin for the db layer's transactional teardown. */
export function removeAttachmentFilesSync(id: string): void {
  if (!isAttachmentId(id)) return;
  for (const ext of Object.keys(MEDIA_BY_EXT)) {
    try {
      unlinkSync(path.join(/* turbopackIgnore: true */ attachmentsDir(), `${id}.${ext}`));
    } catch {
      // absent
    }
  }
}
