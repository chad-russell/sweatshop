import { generateText } from "ai";
import { and, asc, eq, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db";
import { conversations, messages } from "../db/schema";
import { glmFlash } from "./model";

/**
 * 0007 generated titles. After a conversation's first assistant reply a
 * single GLM Flash call writes a 4–6 word title and a one-line summary;
 * it regenerates once more when the conversation reaches
 * REGENERATE_AT_USER_MESSAGES user messages (topics drift). A manual
 * rename (`title_source = 'manual'`) is never overwritten. At most two
 * model calls per conversation, ever.
 */

export const REGENERATE_AT_USER_MESSAGES = 8;
const MAX_GENERATIONS = 2;
const TRANSCRIPT_MESSAGES = 8;
const MESSAGE_CLIP = 600;
const TITLE_MAX = 60;
const SUMMARY_MAX = 200;

export interface GeneratedMeta {
  title: string;
  summary: string;
}

/** Model call seam — tests inject a mock so nothing waits on a real LLM. */
export type TitleGenerator = (transcript: string) => Promise<string>;

const INSTRUCTIONS = `You label chat conversations so a person can find them later.
Reply with exactly two lines and nothing else:
TITLE: <4 to 6 words naming what the conversation is about, no quotes, no trailing period>
SUMMARY: <one sentence, under 25 words, stating the topic and any outcome>`;

async function generateWithGlm(transcript: string): Promise<string> {
  const { text } = await generateText({
    model: glmFlash(),
    system: INSTRUCTIONS,
    prompt: transcript,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(30_000),
  });
  return text;
}

/** Parse the two-line reply; null when the title is unusable. */
export function parseGeneratedMeta(raw: string): GeneratedMeta | null {
  const grab = (label: string): string => {
    const match = raw.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im"));
    return (match?.[1] ?? "").trim();
  };
  const clean = (s: string, max: number) => {
    const collapsed = s
      .replace(/^["'“”‘’`*]+|["'“”‘’`*]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return collapsed.length > max
      ? `${collapsed.slice(0, max - 1).trimEnd()}…`
      : collapsed;
  };
  const title = clean(clean(grab("TITLE"), TITLE_MAX).replace(/[.]+$/, ""), TITLE_MAX);
  if (!title) return null;
  return { title, summary: clean(grab("SUMMARY"), SUMMARY_MAX) };
}

function buildTranscript(db: Db, conversationId: string): string {
  const rows = db
    .select({ role: messages.role, text: messages.text })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.at), asc(sql`rowid`))
    .all();
  // First messages carry the topic; for the regeneration pass, the tail
  // carries where the conversation went — take both ends.
  const head = rows.slice(0, 4);
  const tail = rows.length > TRANSCRIPT_MESSAGES ? rows.slice(-4) : rows.slice(4);
  return [...head, ...tail]
    .map((r) => {
      const clipped =
        r.text.length > MESSAGE_CLIP ? `${r.text.slice(0, MESSAGE_CLIP)}…` : r.text;
      return `${r.role === "user" ? "User" : "Assistant"}: ${clipped}`;
    })
    .join("\n\n");
}

function userMessageCount(db: Db, conversationId: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")))
      .get()?.n ?? 0
  );
}

/**
 * Generate (or regenerate) a title if this conversation is due one.
 * Returns the written metadata, or null when not due / not usable.
 *
 * The generation slot is claimed atomically before the model call so
 * concurrent hook invocations cannot double-spend; a failed call gives
 * the slot back so a later reply retries.
 */
export async function maybeGenerateTitle(
  conversationId: string,
  deps: { db?: Db; generate?: TitleGenerator } = {},
): Promise<GeneratedMeta | null> {
  const db = deps.db ?? defaultDb();
  const generate = deps.generate ?? generateWithGlm;

  const convo = db
    .select({
      titleSource: conversations.titleSource,
      titleGenerations: conversations.titleGenerations,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (!convo || convo.titleSource === "manual") return null;
  if (convo.titleGenerations >= MAX_GENERATIONS) return null;

  const users = userMessageCount(db, conversationId);
  const due =
    convo.titleGenerations === 0
      ? users >= 1
      : users >= REGENERATE_AT_USER_MESSAGES;
  if (!due) return null;

  // Need at least one assistant reply to label from.
  const hasAssistant = db
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
    .get();
  if (!hasAssistant || hasAssistant.n === 0) return null;

  const claimed = db
    .update(conversations)
    .set({ titleGenerations: convo.titleGenerations + 1 })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.titleGenerations, convo.titleGenerations),
      ),
    )
    .run();
  if (claimed.changes === 0) return null;

  const release = () =>
    db
      .update(conversations)
      .set({ titleGenerations: convo.titleGenerations })
      .where(eq(conversations.id, conversationId))
      .run();

  let meta: GeneratedMeta | null;
  try {
    meta = parseGeneratedMeta(await generate(buildTranscript(db, conversationId)));
  } catch (err) {
    release();
    console.error("[titles] generation failed", conversationId, err);
    return null;
  }
  if (!meta) {
    release();
    return null;
  }

  // A rename may have landed while the model was thinking — re-check.
  const written = db
    .update(conversations)
    .set({ title: meta.title, summary: meta.summary || null })
    .where(
      and(eq(conversations.id, conversationId), eq(conversations.titleSource, "auto")),
    )
    .run();
  return written.changes > 0 ? meta : null;
}
