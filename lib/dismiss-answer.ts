/**
 * The answer a question's "Dismiss" button sends. A question holds its
 * turn open on a hook, so dismissing cannot just hide the card — it
 * answers it with text that tells the agent to stop waiting on Chad and
 * continue on its own judgment (a decision it can state, not a guess it
 * hides). Used by the inbox question card and the inline chat card.
 */
export const DISMISS_ANSWER =
  "(Chad dismissed this question without answering — don't wait on it. " +
  "Continue with your best judgment, state any assumption you make, " +
  "and skip whatever depends on his answer if it can't be assumed.)";
