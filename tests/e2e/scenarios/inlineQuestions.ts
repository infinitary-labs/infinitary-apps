import type { Scenario } from "../mockProvider";
import { answering, calledTool } from "../providerRequest";

/**
 * Inline decisions (contract 4.22; tests/e2e/card-questions.spec.ts): a
 * crewmate whose card asks three questions in its body as named form
 * controls - a proposed radio, a required one with no proposal, and a free
 * note. On the captain's reply asking for a revision it revises the card,
 * renaming the required question (`writes` becomes `write-scope`) and
 * keeping the other two, so a spec can watch the other picks survive by
 * name and the renamed one start fresh.
 */
export const INLINE_QUESTIONS_PROMPT_MARKER = "ask the access questions inline";
export const INLINE_QUESTIONS_TITLE = "Three calls settle the access plan";
export const INLINE_QUESTIONS_REVISED_TITLE = "Two calls left on the access plan";
/** The captain's reply that asks for the revision; his picks ride along. */
export const INLINE_QUESTIONS_REVISE_REPLY = "Settle the read scope with these answers";
export const INLINE_QUESTIONS_LOCK_LABEL = "Lock the plan";
export function inlineQuestionsBody(revised: boolean): string {
  const writes = revised ? "write-scope" : "writes";
  return [
    `<p>${revised ? "The read scope is settled; say which tasks may write." : "Each proposed answer is already picked; one needs yours."}</p>`,
    "<fieldset><legend>Which projects can a task read?</legend>",
    '<label><input type="radio" name="read-scope" value="registered" checked> Its registered project, and any you approve</label>',
    '<label><input type="radio" name="read-scope" value="all-visible"> Every project your sign-in can see</label>',
    '<label><input type="radio" name="read-scope" value="other" data-inf-write-in> Something else</label>',
    "</fieldset>",
    "<fieldset><legend>Which tasks can write?</legend>",
    `<label><input type="radio" name="${writes}" value="shipping" required> Tasks that ship a change</label>`,
    `<label><input type="radio" name="${writes}" value="any" required> Any task</label>`,
    `<label><input type="radio" name="${writes}" value="other" required data-inf-write-in> Something else</label>`,
    "</fieldset>",
    '<p><label>Anything else <textarea name="notes"></textarea></label></p>',
  ].join("");
}

/** The crewmate asks its questions on its card, and revises it on the captain's reply. */
export const inlineQuestions: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream || !body.includes(INLINE_QUESTIONS_PROMPT_MARKER))
      return undefined;
    const revise = latestUserTail.includes(INLINE_QUESTIONS_REVISE_REPLY);
    if (!hasToolResults && (!calledTool(body, "emit_card") || revise)) {
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              id: "inline-questions",
              ...(revise
                ? {
                    reply: "Renamed one question; your other picks stay.",
                    ...answering(latestUserTail),
                  }
                : {}),
              title: revise ? INLINE_QUESTIONS_REVISED_TITLE : INLINE_QUESTIONS_TITLE,
              body: inlineQuestionsBody(revise),
              actions: [
                { id: "later", label: "Not now" },
                { id: "lock-plan", label: INLINE_QUESTIONS_LOCK_LABEL, default: true },
              ],
            },
          },
        ],
      };
    }
    return { text: "The questions are on the card." };
  };
