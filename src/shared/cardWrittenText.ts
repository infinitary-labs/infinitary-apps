import type { CardAnswer, CardQuestion } from "./cards";

/**
 * What the captain wrote, not the button or option the author named.
 * Reading typed form facts is not a judgment about whether the words are
 * an instruction. Staged settings and unchanged authored text are not new
 * captain text. Attachments have no input slot here.
 */
export function cardWrittenText(
  caption: string,
  answers: readonly CardAnswer[] = [],
  questions: readonly CardQuestion[] = [],
): string {
  const words = [caption];
  for (const answer of answers) {
    if (answer.written !== undefined) {
      words.push(answer.written);
      continue;
    }
    if (!answer.changed || answer.json) continue;
    const question = questions.find((entry) => entry.name === answer.name);
    if (
      question?.kind === "text" &&
      (question.control === "text" || question.control === "textarea")
    )
      words.push(...answer.values);
  }
  return words.filter((text) => text.trim().length > 0).join("\n\n");
}
