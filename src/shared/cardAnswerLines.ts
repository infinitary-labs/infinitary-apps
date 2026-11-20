import type { CardAnswer } from "./cards";

/**
 * The captain's answers to a card body's own questions, one line each, in
 * the words every reader gets them in - the author's wake, the Firstmate's
 * resolutions line, a build brief grounded in the card (contract 4.22). A
 * picked option reads as the text of the `<label>` bound to it with its
 * value beside it; an option with none reads as its value alone; a staged
 * snapshot stays JSON. What the captain wrote under Something else follows
 * the picks as `written in: "…"`. Whether each differs from what the card
 * proposed is the bridge's typed fact, never read off the words.
 *
 * A question the captain may skip and left untouched (INF-4425) sends its
 * Default, and the bridge marks that answer `skipped`: its line names the
 * option it sent, `- width: skipped, default "Wide" (wide), as proposed`.
 */
export function cardAnswerLines(answers: readonly CardAnswer[]): string[] {
  const option = (value: string, label: string | null | undefined): string =>
    label && label !== value ? `${JSON.stringify(label)} (${value})` : JSON.stringify(value);
  return answers.map((answer) => {
    const parts = answer.json
      ? [`${answer.values[0] ?? ""} (JSON)`]
      : answer.values.map((value, index) => option(value, answer.labels?.[index]));
    if (answer.skipped && parts.length > 0)
      return `- ${answer.name}: skipped, default ${parts.join(", ")}, as proposed`;
    if (answer.written !== undefined) parts.push(`written in: ${JSON.stringify(answer.written)}`);
    const picked = parts.length === 0 ? "no answer" : parts.join(", ");
    return `- ${answer.name}: ${picked}, ${answer.changed ? "changed" : "as proposed"}`;
  });
}

/**
 * The line above a reply's settings in what its author reads: the settings
 * are context for the captain's words, never permission.
 */
export const REPLY_SETTINGS_HEAD = "Current settings (context, not permission):";

/**
 * A captain's reply as its author reads it: his words, then the settings
 * and answers the card sent with them. The thread keeps the two apart
 * (`CardMessage.answers`); every agent reader joins them here.
 */
export function replyWithSettings(text: string, answers?: readonly CardAnswer[]): string {
  return answers?.length
    ? `${text}\n${REPLY_SETTINGS_HEAD}\n${cardAnswerLines(answers).join("\n")}`
    : text;
}

/**
 * Answers as a reader from before `card-answer-skipped` reads them: strictly,
 * so each answer's `skipped` mark is left out and its Default reads as an
 * answer kept as proposed. Anything that is not a list of answers is left as
 * it is.
 */
export function withoutSkipped(answers: unknown): unknown {
  if (!Array.isArray(answers)) return answers;
  return answers.map((answer) => {
    if (!answer || typeof answer !== "object" || !("skipped" in answer)) return answer;
    const { skipped: _skipped, ...kept } = answer as Record<string, unknown>;
    return kept;
  });
}
