/**
 * 0042: the pure half of attachments — ids, `attachment:<id>` references
 * and limits. No Node imports, so client code (lib/chat-ui, the composer)
 * can use it; the fs half is lib/attachments.
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;

/** What a stored message part's `data` looks like: `attachment:<id>`. */
export const ATTACHMENT_SCHEME = "attachment:";
export const attachmentRef = (id: string) => `${ATTACHMENT_SCHEME}${id}`;
export const isAttachmentId = (value: string) => /^att_[a-z0-9]+$/.test(value);

/** The id inside an `attachment:<id>` reference (null when it is not one). */
export function parseAttachmentRef(value: string): string | null {
  if (!value.startsWith(ATTACHMENT_SCHEME)) return null;
  const id = value.slice(ATTACHMENT_SCHEME.length);
  return isAttachmentId(id) ? id : null;
}
