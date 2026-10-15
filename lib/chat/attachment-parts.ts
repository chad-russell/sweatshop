import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { parseAttachmentRef, readAttachmentFile } from "../attachments";

/**
 * 0042: turn stored `attachment:<id>` file parts into image bytes for the
 * provider call. Runs inside the model wrapper's doStream (a step).
 *
 * By the time a part gets here the SDK has normalized it: a v4 model sees
 * `data: { type: "url", url }`, a v3 model (zhipu) a bare URL or string —
 * so all three shapes are recognised, and the bytes go back in the shape
 * the model's spec version expects. A file that is gone (deleted, restored
 * database) becomes the text `[image unavailable]` so a lost file never
 * bricks a conversation. Every other part is untouched.
 */

type Prompt = LanguageModelV4CallOptions["prompt"];

function refOf(data: unknown): string | null {
  if (typeof data === "string") return parseAttachmentRef(data);
  if (data instanceof URL) return parseAttachmentRef(data.toString());
  if (data && typeof data === "object" && (data as { type?: string }).type === "url") {
    const url = (data as { url?: unknown }).url;
    return parseAttachmentRef(url instanceof URL ? url.toString() : String(url));
  }
  return null;
}

export async function resolveAttachmentParts(prompt: Prompt, specificationVersion: "v3" | "v4"): Promise<Prompt> {
  let changed = false;
  const out = await Promise.all(
    prompt.map(async (message) => {
      if (message.role !== "user" || typeof message.content === "string") return message;
      const content = await Promise.all(
        message.content.map(async (part) => {
          if (part.type !== "file") return part;
          const id = refOf(part.data);
          if (!id) return part;
          changed = true;
          const found = await readAttachmentFile(id);
          if (!found) return { type: "text" as const, text: "[image unavailable]" };
          return {
            ...part,
            mediaType: found.mediaType,
            data: specificationVersion === "v3" ? found.data : { type: "data" as const, data: found.data },
          };
        }),
      );
      return { ...message, content } as typeof message;
    }),
  );
  return changed ? (out as Prompt) : prompt;
}
