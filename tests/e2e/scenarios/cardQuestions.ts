import { PREANSWERED_WORDS, WRITE_IN_GAP_WORDS } from "../../../src/core/pi/cardLint";
import type { Scenario } from "../mockProvider";

/**
 * Unpicked choices (contract 4.56; tests/e2e/card-questions.spec.ts): a
 * crewmate that first writes its required questions already answered, the
 * way cards were authored before 4.56, reads the card lint's refusal from
 * the tool result, and emits the same card again with every choice unpicked
 * and its recommendations marked.
 */
export const UNPICKED_PROMPT_MARKER = "ask the release questions unpicked";

export const UNPICKED_TITLE = "Two calls settle the release notes";

export const UNPICKED_DEFAULT_LABEL = "Ship the notes";

export const UNPICKED_REFUSAL = PREANSWERED_WORDS;

export function unpickedQuestionsBody(preanswered: boolean): string {
  return [
    "<p>The release notes can go out once two calls are made.</p>",
    "<p>Both calls change who reads the notes and when they arrive.</p>",
    "<fieldset><legend>Who reads the notes?</legend>",
    `<label><input type="radio" name="audience" value="project" required ${preanswered ? "checked" : "data-inf-recommended"}> The whole project</label>`,
    '<label><input type="radio" name="audience" value="me"> Only me</label>',
    '<label><input type="radio" name="audience" value="other" data-inf-write-in> Something else</label>',
    "</fieldset>",
    '<label for="ship-day">When should they arrive?</label><select id="ship-day" name="ship-day" required>',
    preanswered
      ? '<option value="friday" selected>Friday</option>'
      : '<option value="">Choose</option><option value="friday" data-inf-recommended>Friday</option>',
    '<option value="monday">Monday</option><option value="other" data-inf-write-in>Something else</option></select>',
  ].join("");
}

/**
 * Something else (FI3-1002; tests/e2e/card-questions.spec.ts): a crewmate
 * that first asks its questions with no Something else row, reads the card
 * lint's refusal from the tool result, and emits the same card again with
 * the row on each question - one question opted out with
 * `data-inf-options-only` instead.
 */
export const WRITE_IN_PROMPT_MARKER = "ask the launch questions with a way out";

export const WRITE_IN_TITLE = "Two calls before the launch check";

export const WRITE_IN_DEFAULT_LABEL = "Send answers";

export const WRITE_IN_REFUSAL = WRITE_IN_GAP_WORDS;

export function writeInQuestionsBody(rows: boolean): string {
  return [
    "<p>The launch check can run once you make two calls.</p>",
    "<p>Your key's app did not answer when this Mac woke.</p>",
    "<fieldset><legend>What should happen when your key's app does not answer?</legend>",
    '<label><input type="radio" name="key_app" value="retry" required data-inf-recommended> Keep trying quietly, and say it once</label>',
    '<label><input type="radio" name="key_app" value="keep" required> Keep it as built</label>',
    rows
      ? '<label><input type="radio" name="key_app" value="other" required data-inf-write-in> Something else</label>'
      : "",
    "</fieldset>",
    '<label for="retry_every">How often should it try again?</label><select id="retry_every" name="retry_every">',
    '<option value="">Choose</option><option value="5m" data-inf-recommended>Every 5 minutes</option><option value="wake">Only when this Mac wakes</option>',
    rows ? '<option value="other" data-inf-write-in>Something else</option>' : "",
    "</select>",
    "<fieldset data-inf-options-only><legend>Which account runs the check?</legend>",
    '<label><input type="radio" name="account" value="work" data-inf-recommended> Work account</label>',
    '<label><input type="radio" name="account" value="home"> Home account</label>',
    "</fieldset>",
  ].join("");
}

/**
 * The question crewmates: each card's first emit is refused, unpicked
 * defaults or a missing Something else row, and the refusal brings it back right.
 */
export const cardQuestions: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream) return undefined;
    // Unpicked choices (contract 4.56): the first emit preanswers its
    // required questions and is refused; the refusal in the tool result
    // brings the same card back unpicked, its recommendations marked.
    if (!isFirstmate && body.includes(UNPICKED_PROMPT_MARKER) && wantsStream) {
      // The captain's choice is answered, never met with the card again.
      if (latestUserTail.includes("the user chose")) {
        return { text: "Shipping the notes, as chosen." };
      }
      const emits = ['"name":"emit_card","arguments"', '"name": "emit_card", "arguments"']
        .map((call) => latestUserTail.split(call).length - 1)
        .reduce((sum, count) => sum + count, 0);
      const refused = hasToolResults && latestUserTail.includes(UNPICKED_REFUSAL);
      if (emits === 0 || (emits === 1 && refused)) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                id: "unpicked-questions",
                title: UNPICKED_TITLE,
                body: unpickedQuestionsBody(!refused),
                actions: [
                  { id: "not-now", label: "Not now" },
                  { id: "ship-notes", label: UNPICKED_DEFAULT_LABEL, default: true },
                ],
              },
            },
          ],
        };
      }
      return { text: "The release questions are on the card." };
    }
    // Something else (FI3-1002): the first emit has no row and is
    // refused; the refusal brings the same card back with one.
    if (!isFirstmate && body.includes(WRITE_IN_PROMPT_MARKER) && wantsStream) {
      if (latestUserTail.includes("the user chose")) {
        return { text: "Following your own answer, as written." };
      }
      const emits = ['"name":"emit_card","arguments"', '"name": "emit_card", "arguments"']
        .map((call) => latestUserTail.split(call).length - 1)
        .reduce((sum, count) => sum + count, 0);
      const refused = hasToolResults && latestUserTail.includes(WRITE_IN_REFUSAL);
      if (emits === 0 || (emits === 1 && refused)) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                id: "write-in-questions",
                title: WRITE_IN_TITLE,
                body: writeInQuestionsBody(refused),
                actions: [
                  { id: "not-now", label: "Not now" },
                  { id: "send-answers", label: WRITE_IN_DEFAULT_LABEL, default: true },
                ],
              },
            },
          ],
        };
      }
      return { text: "The launch questions are on the card." };
    }
    return undefined;
  };
