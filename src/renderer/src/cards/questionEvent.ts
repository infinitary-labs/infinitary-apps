/**
 * How a window command asks the shown card to step through its body's
 * questions (docs/keyboard.md, "Moving between a card's questions"): an
 * event on the card's body, which the card's footer hears (`StackedCard`).
 */
export const QUESTION_EVENT = "fm-question";

/** Asks the card whose body this is to step: `unpicked` to the next question with no answer. */
export function askQuestionStep(body: HTMLElement, step: 1 | -1, unpicked = false): void {
  body.dispatchEvent(new CustomEvent(QUESTION_EVENT, { detail: { step, unpicked } }));
}
