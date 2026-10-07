/**
 * 0031: dynamic-import loaders for the Node modules the chat steps use
 * (the "step ceremony" that CAN move — the `"use step"` directive
 * itself cannot; see docs/0031). Statically importable: this module
 * holds no static Node imports, so it is workflow-bundle-safe and the
 * loads stay lazy inside each step.
 */

/** The db handle plus the chat store — the pair most steps want. */
export async function chatStore() {
  const [{ db }, chat] = await Promise.all([import("../../db"), import("../../db/chat")]);
  return { db: db(), chat };
}
