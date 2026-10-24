/**
 * What the question says (the captain's Build it on the close-question
 * prototype): the picks, and the words in the card's one field (INF-924).
 */
export function closeQuestionWords(count: number, preview: boolean, wrote = false): string {
  const noun = preview ? "setting" : "answer";
  const what = count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
  const picked = `${preview ? "changed" : "picked"} ${what}`;
  if (wrote && count === 0) return "You wrote a reply. Closing will discard it.";
  if (wrote) return `You ${picked} and wrote a reply. Closing will discard them.`;
  return `You ${picked}. Closing will discard ${count === 1 ? "it" : "them"}.`;
}

/**
 * What the card's × says on rest (INF-770): a close ends this card, and
 * where it stays to be read - the record of `taskKey`, the task the card
 * is about, or Tasks for a card about none.
 */
export function closeRestWords(taskKey: string | undefined): string {
  return taskKey ? `Close · stays on ${taskKey}'s record` : "Close · stays readable in Tasks";
}

/** The two choices of the close's question about an unanswered reply (INF-770). */
export const PUT_ASIDE_INSTEAD = "Put aside instead";
export const CLOSE_ANYWAY = "Close anyway";

/**
 * What the close's question says while the captain's reply is the newest
 * line on the thread (INF-770): who has not answered, and where its answer
 * goes once the card is closed. `author` is "crewmate 7" or "your first mate".
 */
export function unansweredReplyWords(author: string, taskKey: string | undefined): string {
  const who = author.charAt(0).toUpperCase() + author.slice(1);
  const where = taskKey ? `stays on ${taskKey}'s record` : "stays readable in Tasks";
  return `${who} has not answered your reply yet. Closed, its answer ${where}.`;
}
