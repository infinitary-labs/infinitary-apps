/**
 * What the question says (the captain's Build it on the close-question
 * prototype): the picks, and the words in the Anything else? box (INF-680).
 */
export function closeQuestionWords(count: number, preview: boolean, wrote = false): string {
  const noun = preview ? "setting" : "answer";
  const what = count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
  const picked = `${preview ? "changed" : "picked"} ${what}`;
  if (wrote && count === 0) return "You wrote a comment. Closing will discard it.";
  if (wrote) return `You ${picked} and wrote a comment. Closing will discard them.`;
  return `You ${picked}. Closing will discard ${count === 1 ? "it" : "them"}.`;
}
