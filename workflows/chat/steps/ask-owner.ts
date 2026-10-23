/**
 * 0081: resolve ask_owner's structured-question evidence before the
 * pending row is written. A step because screenshot evidence resolves
 * through attach_screenshot's core (node fs + the sandbox provider) —
 * workflow context cannot touch either directly.
 */

import {
  resolveStructuredQuestions,
  validateStructuredQuestions,
  type AskOwnerCard,
  type StructuredQuestionInput,
} from "../../../lib/question-form";

export type AskOwnerCardResult =
  | { ok: true; card: AskOwnerCard | undefined }
  | { ok: false; message: string };

export async function resolveAskOwnerCardStep(
  conversationId: string,
  input: { context?: string; questions?: StructuredQuestionInput[] },
): Promise<AskOwnerCardResult> {
  "use step";
  if (input.questions && input.questions.length > 0) {
    const check = validateStructuredQuestions(input.questions);
    if (!check.ok) return check;
    const { attachScreenshotTool } = await import("../../../lib/agent/tools/screenshot");
    const questions = await resolveStructuredQuestions(input.questions, async (shot) => {
      const result = await attachScreenshotTool(conversationId, shot);
      return result.ok ? { ok: true, id: result.id, url: result.url } : { ok: false };
    });
    return { ok: true, card: { kind: "ask_owner", ...(input.context ? { context: input.context } : {}), questions } };
  }
  if (input.context) return { ok: true, card: { kind: "ask_owner", context: input.context } };
  return { ok: true, card: undefined };
}
